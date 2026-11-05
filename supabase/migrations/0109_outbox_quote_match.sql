-- 0109 — odchozí fronta: shoda ceny nabídky při odeslání (nález nezávislé revize).
--
-- PROBLÉM: text nabídky a quote_total v agent_outbox se zafixují při zařazení
-- (agent_outbox_enqueue, 0104). Když člověk potom upraví částku nebo rozsah
-- verze nabídky (deal_scope_version — koncept jde měnit, dokud není schválený
-- k odeslání) a odeslání schválí, schválení kryje NOVÝ obsah verze, ale
-- fronta pošle STARÝ text se starou cenou.
--
-- OPRAVA:
--   1) agent_outbox.quote_fingerprint — otisk obsahu verze (částky, měna,
--      rozsah, doklad; approval_offer_content z 0084) v okamžiku zařazení.
--      Doplní ho trigger BEFORE INSERT, takže agent_outbox_enqueue (0104)
--      se nemění. Starší řádky otisk nemají (NULL) — u nich se porovná jen
--      částka.
--   2) agent_outbox_claim (předefinovaný, stejný podpis a práva): u nabídky
--      porovná quote_total s aktuální částkou verze (jednorázově + 12 ×
--      měsíčně, stejně jako enqueue) a otisk s aktuálním obsahem. Neshoda →
--      zpráva needs_attention / stop_reason 'quote_mismatch', úkol pro
--      obchod (CSO: vlastník obchodu, schránka, vlastník uzlu nabídek) s oběma
--      částkami a pokynem koncept přegenerovat; claim vrátí
--      {ok: false, reason: 'quote_mismatch'} a NIC se neodešle. Zprávu
--      ve stavu quote_mismatch fronta sama nikdy nepošle (needs_attention
--      bez rezervace nejde potvrdit ani dohledat).
--
-- 0104 se nemění. Opakovaný běh je bezpečný (IF NOT EXISTS, OR REPLACE se
-- stejným podpisem, DROP TRIGGER IF EXISTS).

DO $$
BEGIN
  IF to_regclass('public.agent_outbox') IS NULL
     OR to_regprocedure('public.approval_offer_content(deal_scope_version)') IS NULL
     OR to_regprocedure('public.agent_outbox_task(agent_outbox, text, text)') IS NULL THEN
    RAISE EXCEPTION '0109 vyžaduje 0084 (approval_offer_content) a 0104 (agent_outbox)';
  END IF;
END $$;

-- ===========================================================================
-- 1) Otisk obsahu verze při zařazení
-- ===========================================================================

ALTER TABLE agent_outbox ADD COLUMN IF NOT EXISTS quote_fingerprint text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_outbox_quote_fingerprint_check') THEN
    ALTER TABLE agent_outbox ADD CONSTRAINT agent_outbox_quote_fingerprint_check
      CHECK (quote_fingerprint IS NULL OR (kind = 'offer' AND quote_fingerprint ~ '^[0-9a-f]{64}$'));
  END IF;
END $$;
COMMENT ON COLUMN agent_outbox.quote_fingerprint IS
  'Otisk obsahu verze nabídky (částky, měna, rozsah) při zařazení (0109). agent_outbox_claim při neshodě zprávu zablokuje (quote_mismatch).';

-- Otisk obsahu verze: stejný obsah, jaký kryje schválení odeslání (0084).
CREATE OR REPLACE FUNCTION agent_outbox_offer_fingerprint(p_version deal_scope_version)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(approval_offer_content(p_version)::text, 'UTF8')), 'hex')
$$;

-- Částka nabídky tak, jak ji počítá agent_outbox_enqueue (0104).
CREATE OR REPLACE FUNCTION agent_outbox_offer_total(p_version deal_scope_version)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT round(p_version.amount_one_time + 12 * p_version.expected_mrr, 2)
$$;

CREATE OR REPLACE FUNCTION agent_outbox_quote_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ver deal_scope_version%ROWTYPE;
BEGIN
  IF NEW.kind = 'offer' AND NEW.scope_version_id IS NOT NULL THEN
    SELECT * INTO v_ver FROM deal_scope_version WHERE id = NEW.scope_version_id;
    IF FOUND THEN
      NEW.quote_fingerprint := agent_outbox_offer_fingerprint(v_ver);
    END IF;
  ELSE
    NEW.quote_fingerprint := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agent_outbox_quote_snapshot ON agent_outbox;
CREATE TRIGGER agent_outbox_quote_snapshot BEFORE INSERT ON agent_outbox
  FOR EACH ROW EXECUTE FUNCTION agent_outbox_quote_snapshot();

-- Sedí zafixovaný text (quote_total, otisk) s aktuální verzí?
CREATE OR REPLACE FUNCTION agent_outbox_quote_matches(p_row agent_outbox, p_version deal_scope_version)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_row.quote_total IS NOT DISTINCT FROM agent_outbox_offer_total(p_version)
     AND (p_row.quote_fingerprint IS NULL OR p_row.quote_fingerprint = agent_outbox_offer_fingerprint(p_version))
$$;

-- Neshoda ceny: needs_attention + úkol pro obchod + audit (jen id a kódy).
CREATE OR REPLACE FUNCTION agent_outbox_block_quote_mismatch(p_row agent_outbox, p_version deal_scope_version)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task  bigint;
  v_now   numeric := agent_outbox_offer_total(p_version);
  v_same  boolean := p_row.quote_total IS NOT DISTINCT FROM v_now;
BEGIN
  v_task := agent_outbox_task(p_row,
    'Přegenerovat nabídku: ' || CASE WHEN v_same THEN 'změnil se rozsah' ELSE 'změnila se cena' END
      || ' (verze ' || p_version.version || ', fronta č. ' || p_row.id || ')',
    'Agent připravil text nabídky pro verzi ' || p_version.version || CASE
      WHEN v_same THEN ', ale rozsah nebo podmínky verze se od té doby změnily'
      ELSE ' s částkou ' || coalesce(to_char(p_row.quote_total, 'FM999999999990.00'), '?') || ' ' || p_version.currency::text
        || ', verze má teď ' || to_char(v_now, 'FM999999999990.00') || ' ' || p_version.currency::text
    END
      || '. Fronta zprávu NEODEŠLE, aby zákazník nedostal starou cenu. Koncept se musí přegenerovat: '
      || 'pošli nabídku z aktuální verze sám (nebo nech agenta připravit novou odpověď) a tuto zprávu ve frontě nech být.');
  UPDATE agent_outbox
     SET status = 'needs_attention', stop_reason = 'quote_mismatch', error_code = NULL, task_id = coalesce(v_task, task_id)
   WHERE id = p_row.id;
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
  VALUES ('system', 'agent_outbox', 'offer.quote_mismatch', 'agent_outbox', p_row.id, NULL,
          jsonb_build_object('kind', p_row.kind, 'deal_id', p_row.deal_id, 'scope_version_id', p_row.scope_version_id,
                             'price_changed', NOT v_same, 'price_map_version', p_row.price_map_version, 'task_id', v_task));
  RETURN v_task;
END $$;

-- ===========================================================================
-- 2) Rezervace odeslání (claim) — 0104 + kontrola shody ceny
-- ===========================================================================

-- Vrací {ok, reason}. reason: not_found | not_queued | quote_mismatch (0109,
-- zpráva přešla do needs_attention s úkolem) | not_authorized | not_approved
-- | daily_limit | recipient_limit | invalid. Bez ok se nic neodesílá.
CREATE OR REPLACE FUNCTION agent_outbox_claim(
  p_id                   bigint,
  p_recipient            text,
  p_rfc_message_id       text,
  p_autonomous           boolean,
  p_daily_limit          integer,
  p_limit_kinds          text[],
  p_per_recipient_limit  integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row       agent_outbox%ROWTYPE;
  v_day       date := agent_outbox_today();
  v_recipient text := lower(btrim(coalesce(p_recipient, '')));
  v_count     integer;
  v_approved  boolean;
  v_ver       deal_scope_version%ROWTYPE;
BEGIN
  IF v_recipient !~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+\.[^@[:space:]<>,;]+$' OR char_length(v_recipient) > 254
     OR p_rfc_message_id IS NULL OR p_rfc_message_id !~ '^<[A-Za-z0-9._-]{1,120}@[A-Za-z0-9.-]{1,70}>$'
     OR p_daily_limit IS NULL OR p_daily_limit < 0 OR p_per_recipient_limit IS NULL OR p_per_recipient_limit < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- Jeden claim po druhém v rámci pražského dne: počty limitů jsou přesné
  -- i při dvou souběžných bězích.
  PERFORM pg_advisory_xact_lock(hashtext('agent_outbox:' || v_day::text));

  SELECT * INTO v_row FROM agent_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_row.status <> 'queued' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_queued');
  END IF;

  -- 0109: shoda ceny. Text nabídky a quote_total se zafixovaly při zařazení;
  -- když člověk potom změnil částku nebo rozsah verze, odešla by stará cena.
  -- Platí pro samostatné odeslání i pro odeslání po schválení člověkem.
  IF v_row.kind = 'offer' AND v_row.scope_version_id IS NOT NULL THEN
    SELECT * INTO v_ver FROM deal_scope_version WHERE id = v_row.scope_version_id FOR SHARE;
    IF FOUND AND NOT agent_outbox_quote_matches(v_row, v_ver) THEN
      PERFORM agent_outbox_block_quote_mismatch(v_row, v_ver);
      RETURN jsonb_build_object('ok', false, 'reason', 'quote_mismatch');
    END IF;
  END IF;

  IF coalesce(p_autonomous, false) THEN
    -- Druhá pojistka za TS: bez pravidla L4 se samostatně neposílá.
    IF NOT agent_outbox_autonomy_granted(v_row.kind) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
  ELSE
    -- Nabídka po schválení = verze schválená k odeslání (0084), jinak by
    -- potvrzení po odeslání narazilo na strážce SV006. Ostatní druhy
    -- uvolňuje člověk (agent_outbox_release → approved_at).
    IF v_row.kind = 'offer' THEN
      v_approved := EXISTS (SELECT 1 FROM deal_scope_version v
                             WHERE v.id = v_row.scope_version_id AND v.status = 'draft' AND v.send_approved_at IS NOT NULL);
    ELSE
      v_approved := v_row.approved_at IS NOT NULL;
    END IF;
    IF NOT v_approved THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_approved');
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM agent_outbox
   WHERE prague_day = v_day AND kind = ANY (coalesce(p_limit_kinds, ARRAY[v_row.kind]))
     AND status IN ('claimed', 'sent', 'needs_attention');
  IF v_count >= p_daily_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'daily_limit');
  END IF;

  SELECT count(*) INTO v_count FROM agent_outbox
   WHERE prague_day = v_day AND lower(recipient) = v_recipient
     AND status IN ('claimed', 'sent', 'needs_attention');
  IF v_count >= p_per_recipient_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recipient_limit');
  END IF;

  UPDATE agent_outbox
     SET status = 'claimed', claimed_at = now(), prague_day = v_day, recipient = v_recipient,
         rfc_message_id = p_rfc_message_id, autonomous = coalesce(p_autonomous, false),
         attempts = attempts + 1, stop_reason = NULL, error_code = NULL
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'prague_day', v_day);
END $$;

-- ===========================================================================
-- 3) Oprávnění (claim si je z 0104 drží — OR REPLACE se stejným podpisem)
-- ===========================================================================

REVOKE ALL ON FUNCTION agent_outbox_offer_fingerprint(deal_scope_version) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_offer_total(deal_scope_version) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_quote_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_quote_matches(agent_outbox, deal_scope_version) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_block_quote_mismatch(agent_outbox, deal_scope_version) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_claim(bigint, text, text, boolean, integer, text[], integer) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION agent_outbox_claim(bigint, text, text, boolean, integer, text[], integer) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0109', 'agent_outbox: shoda ceny nabidky pri odeslani (quote_fingerprint pri zarazeni, claim pri neshode castky nebo rozsahu -> needs_attention/quote_mismatch + ukol pro obchod)')
ON CONFLICT (version) DO NOTHING;
