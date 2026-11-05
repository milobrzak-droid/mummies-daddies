-- 0089 — Pravidla úložiště (Supabase Storage, tabulka storage.objects).
--
-- PROČ: migrace dosud nezakládaly žádnou politiku pro storage.objects. Jediný
-- bucket projektu je 'nabidky' (0015, privátní): PDF importovaných nabídek
-- (offers/<uuid>.pdf) a vedle nich návrh AI (offers/<uuid>.navrh.json).
-- Aplikace do něj sahá VÝHRADNĚ přes servisní klíč (domain/crm/actions/
-- offers.ts: upload, download, remove; app/(app)/clients/[id]/page.tsx:
-- createSignedUrl), a to až po bráně requireUser({ aal2: true }) +
-- memberSeesSales. Bucket 'db-backups' (scripts/backup/) leží v jiném
-- projektu (trezor záloh), sem nepatří. Bez politik dnes klient (anon,
-- authenticated) k úložišti nemá přístup jen díky výchozímu „RLS bez politik“
-- v Supabase — v repozitáři to nebylo nikde zapsané ani ověřené.
--
-- CO SE MĚNÍ (jen politiky; soubory ani buckety se nemažou)
--
-- 1) Bucket 'nabidky' zůstává privátní: public = false (idempotentně).
--
-- 2) Čtení 'nabidky' přes klientskou session (PERMISIVNÍ nabidky_sales_read,
--    FOR SELECT): jen aktivní interní člen týmu s obchodní rolí —
--    is_team_member() (0082: vedeni, obchodnik, projektak, lektor, bez
--    deaktivovaných) AND can_see_sales() (0069: vedeni, obchodnik). Stejné
--    pravidlo jako RLS obchodů (0058) — kdo vidí obchod, smí vidět jeho PDF.
--
-- 3) ZÁPIS do 'nabidky' přes klientskou session NIKDO (RESTRICTIVE
--    nabidky_no_client_insert/update/delete). Zápis je jen server akce se
--    servisním klíčem, která obchodní roli a AAL2 kontroluje sama. Důvod
--    zákazu i pro obchodní role: návrh AI (*.navrh.json) se ukládá na server
--    právě proto, aby ho nešlo podvrhnout (confirmOffer ho čte odsud). Kdyby
--    obchodník směl nahrát vlastní offers/<uuid>.navrh.json přímo přes
--    Storage API, potvrdil by „návrh AI“ bez příznaků, který AI nikdy
--    nenavrhla. Restriktivní zákaz platí, i kdyby někdo později omylem
--    přidal permisivní zápisovou politiku.
--
-- 4) Celé úložiště (všechny buckety) pro klientské role anon a authenticated
--    RESTRICTIVE storage_team_aal2: jen aktivní interní člen týmu s AAL2
--    (vzor require_aal2 z 0007/0024 + is_team_member z 0082). Partner,
--    deaktivovaný člen, session bez 2FA a anon tedy neuvidí nic ani v
--    budoucím bucketu, dokud mu někdo výslovně nepřidá politiku (a i pak
--    jen s AAL2). Veřejné buckety (public = true) jejich veřejnou URL RLS
--    neřeší — žádný tu není a 1) to pro 'nabidky' hlídá.
--
-- CO SE NEMĚNÍ: service_role (servisní klíč aplikace) RLS obchází —
-- import nabídek, potvrzení, podepsané odkazy na PDF jedou beze změny.
-- Podepsaný odkaz (createSignedUrl) se RLS neřídí, platí jen jeho podpis.
--
-- GUARD: když schéma storage (tabulka storage.objects) neexistuje (čistý
-- Postgres, PGlite, lokální DB bez Supabase Storage), migrace politiky
-- přeskočí s NOTICE a zapíše jen řádek do ledgeru. V Supabase schéma
-- existuje vždy. Chybí-li is_team_member()/can_see_sales() nebo ledger,
-- skončí srozumitelnou chybou.
--
-- OPRÁVNĚNÍ: storage.objects vlastní supabase_storage_admin; Supabase roli
-- postgres dovoluje na ní zakládat a mazat politiky (tak to ukazuje i jejich
-- dokumentace Storage Access Control). Kdyby to cíl nedovolil, migrace
-- skončí česky srozumitelnou chybou a vrátí se celá (běhač = jedna transakce).
--
-- ZÁVISLOSTI: 0015 (bucket nabidky), 0020/0069 (can_see_sales), 0082
-- (is_team_member s allowlistem rolí), 0026 (ledger).
-- Idempotentní: DROP POLICY IF EXISTS + CREATE, UPDATE … WHERE public,
-- ON CONFLICT DO NOTHING. Zámky: CREATE/DROP POLICY krátký ACCESS EXCLUSIVE
-- na storage.objects (malá tabulka, nahrávání nabídek je řídké).
-- Ověření: test/storage-0089-pglite.test.ts (Postgres v PGlite se stubem
-- schématu storage: čtení podle role, zákaz zápisu, AAL2, guardy).

DO $$
BEGIN
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0089 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql a 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0089 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0089 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

DO $$
DECLARE
  v_team_aal2 constant text :=
    '(SELECT auth.jwt() ->> ''aal'') = ''aal2'' AND (SELECT public.is_team_member())';
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '0089: schéma storage (tabulka storage.objects) neexistuje — politiky úložiště přeskočeny (mimo Supabase je to v pořádku).';
    RETURN;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    -- Supabase má RLS na storage.objects zapnuté vždy; ALTER TABLE tam
    -- postgres nesmí. Bez RLS by politiky nic neznamenaly — radši stop.
    RAISE EXCEPTION '0089: storage.objects nemá zapnuté RLS — zapněte ho (Supabase → Storage → Policies) a migraci pusťte znovu';
  END IF;

  -- 1) Bucket nabidky zůstává privátní (chybí-li, nic se nezakládá — to je 0015).
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets SET public = false WHERE id = 'nabidky' AND public IS DISTINCT FROM false;
  END IF;

  -- 2) Čtení nabidky: člen týmu s obchodní rolí.
  EXECUTE 'DROP POLICY IF EXISTS nabidky_sales_read ON storage.objects';
  EXECUTE 'CREATE POLICY nabidky_sales_read ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = ''nabidky'' AND (SELECT public.is_team_member()) AND (SELECT public.can_see_sales()))';

  -- 3) Zápis do nabidky přes klienta nikdo (jen servisní klíč, RLS obchází).
  EXECUTE 'DROP POLICY IF EXISTS nabidky_no_client_insert ON storage.objects';
  EXECUTE 'CREATE POLICY nabidky_no_client_insert ON storage.objects
    AS RESTRICTIVE FOR INSERT TO anon, authenticated
    WITH CHECK (bucket_id <> ''nabidky'')';
  EXECUTE 'DROP POLICY IF EXISTS nabidky_no_client_update ON storage.objects';
  EXECUTE 'CREATE POLICY nabidky_no_client_update ON storage.objects
    AS RESTRICTIVE FOR UPDATE TO anon, authenticated
    USING (bucket_id <> ''nabidky'') WITH CHECK (bucket_id <> ''nabidky'')';
  EXECUTE 'DROP POLICY IF EXISTS nabidky_no_client_delete ON storage.objects';
  EXECUTE 'CREATE POLICY nabidky_no_client_delete ON storage.objects
    AS RESTRICTIVE FOR DELETE TO anon, authenticated
    USING (bucket_id <> ''nabidky'')';

  -- 4) Celé úložiště: jen aktivní interní člen týmu s 2FA (AAL2).
  EXECUTE 'DROP POLICY IF EXISTS storage_team_aal2 ON storage.objects';
  EXECUTE format('CREATE POLICY storage_team_aal2 ON storage.objects
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (%s) WITH CHECK (%s)', v_team_aal2, v_team_aal2);
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION '0089: chybí oprávnění zakládat politiky na storage.objects (%). Aplikujte migraci jako postgres (SQL editor Supabase) nebo politiky založte v Supabase → Storage → Policies podle tohoto souboru.', SQLERRM;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0089', 'storage.objects: nabidky čte jen obchodní role (AAL2), zápis jen servisní klíč, celé úložiště jen tým s 2FA')
ON CONFLICT (version) DO NOTHING;
