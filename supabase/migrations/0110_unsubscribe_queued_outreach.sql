-- 0110 — odhlášení z oslovení zastaví i oslovení, které už čeká ve frontě
-- (nález nezávislé revize).
--
-- PROBLÉM: outbound_unsubscribe (0107) přepnul na 'skipped' jen oslovení ve
-- stavu draft / approved. Oslovení ve stavu 'queued' (už zařazené do odchozí
-- fronty agent_outbox, kind 'outreach') zůstalo ve frontě a odešlo by i po
-- odhlášení adresáta. Úloha outbound agenta kontroluje odhlášení jen před
-- zařazením; odchozí fronta ho nezná.
--
-- OPRAVA:
--   1) outbound_unsubscribe (předefinovaná, stejný podpis a práva):
--      - oslovení ve stavu draft / approved / queued → 'skipped'; výjimka je
--        oslovení, jehož zpráva je právě rozpracovaná nebo možná odeslaná
--        (fronta claimed / needs_attention / sent) — to dořeší fronta
--        (potvrzení, dohledání v Odeslané poště); znovu odeslat ho nejde (2),
--      - odpovídající zprávy fronty (source_ref 'outreach:<id>' nebo stejná
--        adresa příjemce) ve stavu queued / blocked / failed → 'blocked'
--        s důvodem 'unsubscribed'.
--   2) pojistka na agent_outbox (trigger BEFORE UPDATE OF status): oslovení
--      odhlášené adresy se do fronty nevrátí — uvolnění člověkem
--      (agent_outbox_release) ani vrácená rezervace (throttled) z něj
--      'queued' neudělá, zpráva zůstane 'blocked' / 'unsubscribed' a oslovení
--      se přepne na 'skipped'.
--
-- Opakovaný běh je bezpečný (OR REPLACE se stejným podpisem, DROP TRIGGER IF EXISTS).

DO $$
BEGIN
  IF to_regprocedure('public.outbound_unsubscribe(jsonb)') IS NULL OR to_regclass('public.agent_outbox') IS NULL
     OR to_regprocedure('public.outbound_email_hash(text)') IS NULL THEN
    RAISE EXCEPTION '0110 vyžaduje 0104 (agent_outbox) a 0107 (outbound_unsubscribe)';
  END IF;
END $$;

-- ===========================================================================
-- 1) Odhlášení: i oslovení ve frontě
-- ===========================================================================

CREATE OR REPLACE FUNCTION outbound_unsubscribe(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hash text;
  v_source text;
  v_outreach bigint;
  v_n integer;
  v_blocked integer;
BEGIN
  v_hash := lower(p ->> 'email_hash');
  v_source := coalesce(p ->> 'source', 'unsubscribe_link');
  v_outreach := (p ->> 'outreach_id')::bigint;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'OU000: neplatný otisk adresy' USING ERRCODE = 'check_violation';
  END IF;
  IF v_outreach IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbound_outreach WHERE id = v_outreach) THEN
    v_outreach := NULL;
  END IF;

  INSERT INTO outreach_suppression (email_hash, source, outreach_id, recorded_by)
  VALUES (v_hash, v_source, v_outreach, (p ->> 'recorded_by')::uuid)
  ON CONFLICT (email_hash) DO NOTHING;

  UPDATE outreach_consent SET withdrawn_at = now() WHERE email_hash = v_hash AND withdrawn_at IS NULL;

  UPDATE contact
     SET do_not_contact = true, do_not_contact_at = coalesce(do_not_contact_at, now()),
         do_not_contact_reason = coalesce(do_not_contact_reason, 'Odhlásil se z obchodních sdělení')
   WHERE outbound_email_hash(email) = v_hash AND do_not_contact IS DISTINCT FROM true;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 0110: zprávy oslovení ve frontě, které ještě neodešly, se zablokují.
  UPDATE agent_outbox o
     SET status = 'blocked', stop_reason = 'unsubscribed', error_code = NULL
   WHERE o.kind = 'outreach'
     AND o.status IN ('queued', 'blocked', 'failed')
     AND (o.source_ref IN (SELECT 'outreach:' || oo.id FROM outbound_outreach oo WHERE oo.email_hash = v_hash)
          OR (o.to_email IS NOT NULL AND outbound_email_hash(o.to_email) = v_hash)
          OR (o.recipient IS NOT NULL AND outbound_email_hash(o.recipient) = v_hash));
  GET DIAGNOSTICS v_blocked = ROW_COUNT;

  -- Oslovení → skipped (0110: i 'queued'), kromě rozpracované / možná odeslané zprávy.
  UPDATE outbound_outreach oo SET status = 'skipped'
   WHERE oo.email_hash = v_hash AND oo.status IN ('draft', 'approved', 'queued')
     AND NOT EXISTS (SELECT 1 FROM agent_outbox o
                      WHERE o.source_ref = 'outreach:' || oo.id AND o.status IN ('claimed', 'needs_attention', 'sent'));

  RETURN jsonb_build_object('suppressed', true, 'contacts', v_n, 'outbox_blocked', v_blocked);
END;
$$;

-- ===========================================================================
-- 2) Pojistka: odhlášená adresa se do fronty nevrátí
-- ===========================================================================

CREATE OR REPLACE FUNCTION agent_outbox_unsubscribed_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'outreach' AND NEW.status = 'queued' AND OLD.status IS DISTINCT FROM 'queued'
     AND EXISTS (
       SELECT 1 FROM outreach_suppression s
        WHERE s.email_hash IN (
          (SELECT oo.email_hash FROM outbound_outreach oo WHERE 'outreach:' || oo.id = NEW.source_ref),
          CASE WHEN NEW.to_email IS NOT NULL THEN outbound_email_hash(NEW.to_email) END,
          CASE WHEN NEW.recipient IS NOT NULL THEN outbound_email_hash(NEW.recipient) END
        )
     ) THEN
    -- Nic se neodeslalo: rezervace (je-li) se uvolní stejně jako u vrácení do fronty.
    NEW.status := 'blocked';
    NEW.stop_reason := 'unsubscribed';
    NEW.claimed_at := NULL;
    NEW.prague_day := NULL;
    NEW.rfc_message_id := NULL;
    UPDATE outbound_outreach SET status = 'skipped'
     WHERE 'outreach:' || id = NEW.source_ref AND status IN ('draft', 'approved', 'queued');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agent_outbox_unsubscribed_guard ON agent_outbox;
CREATE TRIGGER agent_outbox_unsubscribed_guard BEFORE UPDATE OF status ON agent_outbox
  FOR EACH ROW EXECUTE FUNCTION agent_outbox_unsubscribed_guard();

-- ===========================================================================
-- 3) Oprávnění
-- ===========================================================================

REVOKE ALL ON FUNCTION outbound_unsubscribe(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION agent_outbox_unsubscribed_guard() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION outbound_unsubscribe(jsonb) TO service_role;
  END IF;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0110', 'outbound_unsubscribe: i osloveni ve stavu queued -> skipped a zpravy fronty -> blocked/unsubscribed; pojistka agent_outbox proti navratu odhlasene adresy do fronty')
ON CONFLICT (version) DO NOTHING;
