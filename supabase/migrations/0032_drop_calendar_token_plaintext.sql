-- 0032 — Šifrování Microsoft Graph tokenů v `calendar_token` (krok 2 ze 2).
--
-- Pokračování 0031. Ten krok přidal access_token_encrypted /
-- refresh_token_encrypted a ověřil SQL assertem, že dešifrování dá přesně
-- původní hodnotu — teprve po tom ověření dává smysl staré plaintext
-- sloupce smazat. Kdyby 0031 selhalo (RAISE EXCEPTION v jeho verifikačním
-- DO bloku), celé se transakčně vrátilo a tahle migrace by narazila na
-- neexistující/neúplné *_encrypted sloupce — nespouštět 0032 ručně, dokud
-- 0031 prokazatelně neproběhlo (viz schema_migration).
--
-- Proč samostatný soubor/krok a ne rovnou v 0031: aby existoval okamžik,
-- kdy je šifrovaná i plaintext hodnota vedle sebe a jde je porovnat zvenčí
-- (mimo samotnou migraci) předtím, než se stará hodnota nenávratně smaže.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'calendar_token' AND column_name = 'access_token_encrypted'
  ) THEN
    RAISE EXCEPTION '0032: access_token_encrypted neexistuje — 0031 zjevně neproběhlo. Nepokračuji.';
  END IF;
END $$;

ALTER TABLE calendar_token
  DROP COLUMN access_token,
  DROP COLUMN refresh_token;

INSERT INTO schema_migration (version, note)
VALUES ('0032', 'sifrovani calendar_token (krok 2/2): drop plaintext access_token/refresh_token po overenem round-tripu v 0031')
ON CONFLICT (version) DO NOTHING;

COMMIT;
