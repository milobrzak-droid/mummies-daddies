-- 0031 — Šifrování Microsoft Graph tokenů v `calendar_token` (krok 1 ze 2).
--
-- PROČ: bezpečnostní audit této session označil calendar_token.access_token
-- a refresh_token za největší blast radius v celé databázi — refresh token
-- je trvalý přístup do skutečné schránky a kalendáře na Microsoft 365, ne
-- jen dočasné heslo. Dosud oba ležely v čitelném textu: kdokoli s přístupem
-- k DB dumpu, zálze nebo replication streamu je mohl přečíst přímo.
--
-- DŮLEŽITÉ: tahle tabulka NENÍ prázdná. Existuje jeden živý řádek —
-- (na nové databázi tabulka prázdná je; text platí pro existující instalace).
-- access_token je po expiraci (expires_at v minulosti), ale refresh_token
-- může být pořád platný, tedy pořád citlivý. Tahle migrace proto musí
-- existující řádek přešifrovat na místě, ne jen přidat sloupce k prázdné
-- tabulce — a hlavně to musí ověřit, než se čehokoliv starého zbaví.
--
-- POSTUP (krok 1/2 — plaintext sloupce se dropují až v 0032, a to jen
-- pokud tahle migrace projde beze zbytku):
--   1. Vygeneruje se náhodný 256bit klíč PŘÍMO v SQL (gen_random_bytes),
--      nikdy jako literál napsaný do souboru, a uloží se do Supabase
--      Vaultu (vault.create_secret) — do gitu tedy nejde žádné klíčové
--      materiál, jen odkaz na jeho jméno.
--   2. Přidají se nové bytea sloupce pro šifrované hodnoty vedle starých
--      plaintext sloupců (obě verze chvíli existují současně).
--   3. Existující řádek(y) se přešifrují pomocí pgcrypto (pgp_sym_encrypt).
--   4. SQL assert (DO blok s RAISE EXCEPTION) ověří, že dešifrování nových
--      sloupců dá bajt po bajtu přesně původní hodnotu. Pokud ne, celá
--      migrace se transakčně vrátí (implicitní ROLLBACK víceradkového
--      dávkového požadavku) a 0032 se vůbec nedostane ke slovu.
--   5. Vytvoří se SECURITY DEFINER funkce, přes které appka jedině smí
--      k tokenům přistupovat. Klíč z Vaultu se z nich nikdy nevrací ven —
--      funkce vrací buď rovnou dešifrovaný token, nebo nic (void). Stejný
--      vzor jako is_team_member()/is_admin() (0002, 0005): funkce běží
--      jako vlastník (postgres, BYPASSRLS), takže RLS politiky caltoken_self
--      a require_aal2 (0006, 0024) uvnitř funkce fakticky neplatí — proto
--      je funkce replikuje ručně (member_id = auth.uid() a AAL2 check),
--      aby se přidáním téhle vrstvy zabezpečení náhodou nezeslabilo.
--
-- Grant na obyčejné čtení nového bytea sloupce zůstává stejný jako dřív
-- (caltoken_self + require_aal2) — jen už z něj bez klíče z Vaultu nejde
-- nic vyčíst, a Vault sám o sobě není čitelný přes authenticated/anon roli
-- (grant na vault.decrypted_secrets má jen service_role, ověřeno živě
-- před psaním této migrace).

BEGIN;

-- 1) Klíč. IF NOT EXISTS kvůli idempotenci (opakovaný běh po přerušení).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'calendar_token_key') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'calendar_token_key',
      '0031: symetrický klíč pro pgp_sym_encrypt/decrypt na calendar_token.access_token_encrypted / refresh_token_encrypted. Nepoužívat pro nic jiného.'
    );
  END IF;
END $$;

-- 2) Nové sloupce vedle starých — nic staré se v tomhle kroku neruší.
ALTER TABLE calendar_token
  ADD COLUMN IF NOT EXISTS access_token_encrypted  bytea,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted bytea;

-- 3) Přešifrování existujících řádků (dnes jeden, ale ať to funguje i pro N).
--    pgp_sym_encrypt na NULL vstupu vrátí NULL (strict funkce), takže se
--    žádná WHERE podmínka neřeší.
UPDATE calendar_token
SET
  access_token_encrypted  = extensions.pgp_sym_encrypt(
    access_token, (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key')),
  refresh_token_encrypted = extensions.pgp_sym_encrypt(
    refresh_token, (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key'));

-- 4) Ověření round-tripu PŘED tím, než se cokoliv starého smí smazat.
--    IS DISTINCT FROM správně zvládá i NULL vs. NULL (rovná se) a NULL vs.
--    hodnota (různé) — obyčejné != by NULL řádky tiše přeskočilo.
DO $$
DECLARE
  v_key text := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key');
  v_bad_count int;
BEGIN
  SELECT count(*) INTO v_bad_count
  FROM calendar_token
  WHERE access_token  IS DISTINCT FROM extensions.pgp_sym_decrypt(access_token_encrypted,  v_key)
     OR refresh_token IS DISTINCT FROM extensions.pgp_sym_decrypt(refresh_token_encrypted, v_key);

  IF v_bad_count > 0 THEN
    RAISE EXCEPTION
      'calendar_token: ověření šifrovacího round-tripu SELHALO u % řádku/ů — migrace 0031 se vrací zpět, plaintext sloupce zůstávají netknuté, 0032 (drop) se nesmí spustit.',
      v_bad_count;
  END IF;
END $$;

-- 5) Přístupové funkce. Appka od teď nikdy nepíše/nečte access_token_encrypted
--    / refresh_token_encrypted přímo přes .select()/.update() — jde přes tyhle
--    tři RPC, jinak by musela znát klíč z Vaultu.

-- 5a) Dešifrované čtení vlastního řádku (nahrazuje `.select('*')`
--     v lib/graphToken.ts a lib/actions/calendar.ts).
CREATE OR REPLACE FUNCTION calendar_token_get_decrypted(p_member_id uuid)
RETURNS TABLE (
  provider      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  account_email text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
BEGIN
  -- auth.uid() IS NULL explicitně navíc: bez tohohle by anonymní volání
  -- s p_member_id = NULL prošlo přes "IS DISTINCT FROM" (NULL není
  -- distinct od NULL) a spolehli bychom se jen na AAL2 kontrolu níž.
  IF auth.uid() IS NULL OR p_member_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'calendar_token_get_decrypted: cizí member_id';
  END IF;
  IF (SELECT auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'calendar_token_get_decrypted: vyžaduje AAL2';
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

-- 5b) Prvotní zápis po OAuth flow (nahrazuje .upsert() v app/api/ms/callback/route.ts).
CREATE OR REPLACE FUNCTION calendar_token_upsert_encrypted(
  p_member_id     uuid,
  p_provider      text,
  p_access_token  text,
  p_refresh_token text,
  p_expires_at    timestamptz,
  p_account_email text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
BEGIN
  IF auth.uid() IS NULL OR p_member_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'calendar_token_upsert_encrypted: cizí member_id';
  END IF;
  IF (SELECT auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'calendar_token_upsert_encrypted: vyžaduje AAL2';
  END IF;

  v_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key');

  INSERT INTO calendar_token (
    member_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, account_email
  ) VALUES (
    p_member_id, p_provider,
    pgp_sym_encrypt(p_access_token, v_key), pgp_sym_encrypt(p_refresh_token, v_key),
    p_expires_at, p_account_email
  )
  ON CONFLICT (member_id) DO UPDATE SET
    provider                = EXCLUDED.provider,
    access_token_encrypted  = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
    expires_at               = EXCLUDED.expires_at,
    account_email            = EXCLUDED.account_email;
END;
$$;

-- 5c) Přepsání tokenů při obnově (nahrazuje .update() v lib/graphToken.ts
--     a lib/actions/calendar.ts, když accessToken expiroval).
CREATE OR REPLACE FUNCTION calendar_token_update_tokens(
  p_member_id     uuid,
  p_access_token  text,
  p_refresh_token text,
  p_expires_at    timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
BEGIN
  IF auth.uid() IS NULL OR p_member_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'calendar_token_update_tokens: cizí member_id';
  END IF;
  IF (SELECT auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'calendar_token_update_tokens: vyžaduje AAL2';
  END IF;

  v_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'calendar_token_key');

  UPDATE calendar_token SET
    access_token_encrypted  = pgp_sym_encrypt(p_access_token, v_key),
    refresh_token_encrypted = pgp_sym_encrypt(p_refresh_token, v_key),
    expires_at               = p_expires_at
  WHERE member_id = p_member_id;
END;
$$;

-- Nejmenší možná sada práv: nic přes PUBLIC/anon, jen authenticated (appka
-- vždy volá přes RLS-scoped klienta s uživatelskou session, nikdy anonymně).
-- Pozor: Supabase má v public schématu defaultně nastavené ALTER DEFAULT
-- PRIVILEGES tak, že nová funkce automaticky dostane EXECUTE i pro anon —
-- "REVOKE ALL ... FROM PUBLIC" tohle explicitní grant pro roli anon
-- nesundá (PUBLIC != anon), proto je tu REVOKE na anon zvlášť a natvrdo.
REVOKE ALL ON FUNCTION calendar_token_get_decrypted(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION calendar_token_upsert_encrypted(uuid, text, text, text, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION calendar_token_update_tokens(uuid, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION calendar_token_get_decrypted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION calendar_token_upsert_encrypted(uuid, text, text, text, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION calendar_token_update_tokens(uuid, text, text, timestamptz) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0031', 'sifrovani calendar_token (krok 1/2): nove bytea sloupce + prevod existujiciho radku + overeni round-tripu + SECURITY DEFINER pristupove funkce')
ON CONFLICT (version) DO NOTHING;

COMMIT;
