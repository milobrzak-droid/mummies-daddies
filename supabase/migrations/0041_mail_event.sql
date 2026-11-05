-- 0041 — mail_event: metadata e-mailové komunikace pro last_inbound_at /
-- last_outbound_at (docs/PROVOZ.md, kapitola 8).
--
-- Scope rozhodnut 28. 9. 2026: token má Mail.Read (plný obsah pošty), ale
-- Cockpit dál ukládá JEN METADATA — to, co je potřeba pro „kdy naposledy
-- psal / kdy jsme psali". Mail.Read otevírá budoucí klasifikaci odpovědí;
-- ta bude mít vlastní návrh (a ochranu proti prompt injection) a do té doby
-- se obsah ani nečte, ani neukládá. Sync běží jen nad schránkou jednoho
-- člena (OUTLOOK_MAIL_SYNC_MEMBER_ID).
-- NIKDY žádný předmět, tělo ani adresy — u nespárovaných lidí by to bylo
-- zpracování osobních údajů bez účelu. Pro neznámou firmu smí zůstat jen
-- doména (counterpart_domain), a to jen pro firemní doménu, nikdy freemail
-- (to hlídá domain/crm/mailMatch.ts, tady CHECK aspoň na tvar).
--
-- Zápis jde výhradně přes service_role (cron). Klient (authenticated)
-- smí jen číst, a to s AAL2 — stejně jako evidence (0038).
--
-- Tokeny: funkce z 0031 jsou vázané na auth.uid() + AAL2, takže je cron
-- (bez uživatelské session) volat nemůže. Proto vedle nich dvě service-only
-- varianty se stejným klíčem z Vaultu; EXECUTE má jen service_role.
--
-- account_id je ON DELETE CASCADE, ne SET NULL: CHECK
-- mail_event_matched_has_account vyžaduje u 'matched' firmu, takže SET NULL
-- by smazání firmy shodil na porušení CHECKu. Řádky jsou jen metadata
-- komunikace té firmy — bez ní nemají účel, proto odchází s ní.
--
-- Známé, vědomě přijaté drobné riziko: internet_message_id (RFC 5322
-- Message-ID) často obsahuje hostname odesílajícího serveru
-- (<nahodne@mail.firma.cz>). Je to technický identifikátor, ne adresa
-- osoby; potřebujeme ho pro deduplikaci a bez něj by sync nebyl idempotentní.
--
-- Bez explicitního BEGIN/COMMIT: scripts/migrate.mjs obaluje každý soubor
-- vlastní transakcí (stejná konvence jako ostatní migrace).
--
-- Retence: nespárované řádky (unknown / ambiguous) se drží 30 dní od
-- zápisu (created_at), pak je smaže purge_unmatched_mail_events(), kterou
-- volá cron na konci každého běhu. Spárované řádky zůstávají (patří firmě
-- a odcházejí s ní přes ON DELETE CASCADE).
--
-- Migrace se zatím NEAPLIKUJE — aplikuje se až při zapnutí syncu
-- (docs/PROVOZ.md, kapitola 3).

CREATE TABLE IF NOT EXISTS mail_event (
  id                  bigserial PRIMARY KEY,
  internet_message_id text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  occurred_at         timestamptz NOT NULL,
  account_id          bigint REFERENCES account(id) ON DELETE CASCADE,
  contact_id          bigint REFERENCES contact(id) ON DELETE SET NULL,
  match_status        text NOT NULL CHECK (match_status IN ('matched', 'ambiguous', 'unknown')),
  -- Jen doména, nikdy adresa. Bez '@', aby se sem omylem nedostal e-mail.
  counterpart_domain  text CHECK (counterpart_domain IS NULL OR position('@' IN counterpart_domain) = 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Stejná zpráva se při opakovaném syncu nezapíše dvakrát.
  CONSTRAINT mail_event_msg_dir_unique UNIQUE (internet_message_id, direction),
  -- matched musí mít firmu; ostatní stavy firmu mít nesmí (nejistá vazba je horší než žádná).
  CONSTRAINT mail_event_matched_has_account CHECK (
    (match_status = 'matched' AND account_id IS NOT NULL)
    OR (match_status <> 'matched' AND account_id IS NULL AND contact_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS mail_event_account_idx
  ON mail_event(account_id, occurred_at DESC) WHERE account_id IS NOT NULL;
-- Pro purge: nespárované řádky podle stáří.
CREATE INDEX IF NOT EXISTS mail_event_unmatched_created_idx
  ON mail_event(created_at) WHERE match_status <> 'matched';

ALTER TABLE mail_event ENABLE ROW LEVEL SECURITY;

-- Čtení pro tým; žádná INSERT/UPDATE/DELETE politika → klient nezapíše nic.
DROP POLICY IF EXISTS mail_event_read ON mail_event;
CREATE POLICY mail_event_read ON mail_event
  FOR SELECT USING (is_team_member());

DROP POLICY IF EXISTS require_aal2 ON mail_event;
CREATE POLICY require_aal2 ON mail_event
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON mail_event FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON mail_event FROM authenticated;
GRANT SELECT ON mail_event TO authenticated;
GRANT ALL ON mail_event TO service_role;
GRANT USAGE ON SEQUENCE mail_event_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- Tokeny pro cron (service_role). Kontrola role uvnitř je druhá pojistka
-- vedle GRANTu — kdyby někdo později omylem přidal EXECUTE pro authenticated.

CREATE OR REPLACE FUNCTION calendar_token_get_for_service(p_member_id uuid)
RETURNS TABLE (
  provider      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  account_email text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'calendar_token_get_for_service: jen service_role';
  END IF;

  v_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key');

  RETURN QUERY
    SELECT
      ct.provider,
      pgp_sym_decrypt(ct.access_token_encrypted,  v_key),
      pgp_sym_decrypt(ct.refresh_token_encrypted, v_key),
      ct.expires_at,
      ct.account_email
    FROM calendar_token ct
    WHERE ct.member_id = p_member_id;
END;
$$;

-- Rotace při obnově: Microsoft vydá nový refresh token a starý zneplatní,
-- takže ho cron musí uložit, jinak by příští běh skončil na invalid_grant.
CREATE OR REPLACE FUNCTION calendar_token_update_for_service(
  p_member_id     uuid,
  p_access_token  text,
  p_refresh_token text,
  p_expires_at    timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'calendar_token_update_for_service: jen service_role';
  END IF;

  v_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key');

  UPDATE calendar_token SET
    access_token_encrypted  = pgp_sym_encrypt(p_access_token, v_key),
    -- Když Microsoft nový refresh token nepošle, platí dál ten starý.
    refresh_token_encrypted = COALESCE(pgp_sym_encrypt(p_refresh_token, v_key), refresh_token_encrypted),
    expires_at              = p_expires_at
  WHERE member_id = p_member_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Monotónní posun last_inbound_at / last_outbound_at. GREATEST ignoruje
-- NULL, takže první událost hodnotu nastaví a starší (dosync historie,
-- opožděný běh) ji nikdy nevrátí zpátky.
CREATE OR REPLACE FUNCTION apply_mail_event_to_account(
  p_account_id  bigint,
  p_direction   text,
  p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'apply_mail_event_to_account: jen service_role';
  END IF;
  IF p_direction = 'inbound' THEN
    UPDATE account SET last_inbound_at = GREATEST(last_inbound_at, p_occurred_at)
    WHERE id = p_account_id;
  ELSIF p_direction = 'outbound' THEN
    UPDATE account SET last_outbound_at = GREATEST(last_outbound_at, p_occurred_at)
    WHERE id = p_account_id;
  ELSE
    RAISE EXCEPTION 'apply_mail_event_to_account: neplatný směr %', p_direction;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Retence nespárovaných událostí. Počítá se od created_at (kdy jsme řádek
-- uložili), ne od occurred_at — jinak by první sync historie mazal hned po
-- zápisu. Spodní mez 1 den chrání před omylem typu older_than => '0'.
CREATE OR REPLACE FUNCTION purge_unmatched_mail_events(older_than interval DEFAULT '30 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'purge_unmatched_mail_events: jen service_role';
  END IF;
  IF older_than IS NULL OR older_than < interval '1 day' THEN
    RAISE EXCEPTION 'purge_unmatched_mail_events: older_than musí být aspoň 1 den';
  END IF;

  DELETE FROM mail_event
  WHERE match_status IN ('unknown', 'ambiguous')
    AND created_at < now() - older_than;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Supabase dává novým funkcím v public defaultně EXECUTE i pro anon/authenticated
-- (viz 0031) — proto REVOKE natvrdo na všechny tři role.
REVOKE ALL ON FUNCTION calendar_token_get_for_service(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION calendar_token_update_for_service(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION apply_mail_event_to_account(bigint, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purge_unmatched_mail_events(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION calendar_token_get_for_service(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION calendar_token_update_for_service(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION apply_mail_event_to_account(bigint, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION purge_unmatched_mail_events(interval) TO service_role;

INSERT INTO schema_migration (version, note)
VALUES ('0041', 'mail_event (jen metadata, bez obsahu a adres) + service-only tokenove RPC + monotonni last_inbound/outbound + purge nesparovanych po 30 dnech')
ON CONFLICT (version) DO NOTHING;
