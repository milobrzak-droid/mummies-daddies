-- 0062 — Kapacity lidí: týdenní kapacita člena týmu, alokace na dodávku
-- nebo případ a zastupitelnost (kapitola 10 plánu přestavby, část 1:
-- „alokace lidí a zastupitelnost; plán vs. kapacita").
--
-- PROČ: dosud nikde nebylo vidět, kdo na čem pracuje a kolik hodin týdně.
-- Přetížení člověka se ukázalo až ve skluzu termínu a kdo koho zastoupí,
-- věděl jen ten, kdo si to pamatoval. Cílová architektura (entita „Lidé
-- a kapacita": alokace, dostupnost, zastupitel) chce plán proti kapacitě
-- jako data, ne jako tabulku v hlavě vedení.
--
-- CO SE MĚNÍ
--
-- 1) team_member.weekly_capacity_hours — kolik hodin týdně člověk na práci
--    má (numeric(4,1), výchozí 40, CHECK 0–80). 0 = dlouhodobě nedostupný
--    (rodičovská, sabbatical); přetížení je pak každá alokace. Stávající
--    řádky dostanou 40 přes DEFAULT (ADD COLUMN … DEFAULT je v PG 11+ bez
--    přepisu tabulky).
--
-- 2) allocation — alokace člověka (member_id) na JEDNU věc: dodávku
--    (engagement_id) NEBO pracovní případ Loop Core (work_case_id), nikdy
--    obojí ani nic (CHECK num_nonnulls = 1). hours_per_week > 0 a ≤ 80,
--    období starts_on – ends_on (včetně; ends_on NULL = bez konce).
--    substitute_id = zástup (zastupitelnost) — jiný člověk než member_id.
--    Týdenní zatížení, přetížení a varování o zástupu počítá čistá funkce
--    v domain/delivery/capacity.ts (ISO týdny v pásmu firmy z @/config),
--    ne SQL — logika se tak testuje bez databáze.
--    Kaskády: smazání člověka, dodávky nebo případu smaže i jeho alokace
--    (alokace bez člověka nebo bez práce nic neznamená); odchod zástupce
--    zástup jen vynuluje (ON DELETE SET NULL) — alokace pak ukáže varování
--    „bez zástupu", ne tichou ztrátu.
--
-- 3) set_weekly_capacity(p_member_id, p_hours) — změna kapacity. RPC je
--    SECURITY DEFINER s bránou (přihlášený + AAL2 + člen týmu, vzor
--    loop_actor z 0039) a smí: admin (is_admin) a vedeni komukoli, ostatní
--    jen sobě. Mění JEN weekly_capacity_hours — nic dalšího z řádku.
--
-- 4) Zavření díry v team_member (existovala už od 0003, tady ji zavíráme,
--    protože brána v bodě 3 stojí na team_member.role a is_admin): politika
--    team_self (0003) byla FOR UPDATE USING (id = auth.uid()) bez WITH CHECK
--    a bez omezení sloupců a authenticated měl výchozí tabulkový UPDATE.
--    Kdokoli si tak mohl přes PostgREST přepsat vlastní role a is_admin —
--    tím by obešel tuto bránu, can_see_sales() (0020/0058) i requireAdmin().
--    Aplikace team_member přes uživatelskou session nemění (admin úpravy
--    jdou přes service role a set_team_member_admin z 0045, kapacita přes
--    set_weekly_capacity), proto team_self rušíme a UPDATE odebíráme.
--    Čtení zůstává přes team_read. Kdyby jednou člověk měl upravovat sám
--    sebe, jen GRANT UPDATE (konkrétní sloupec), nikdy role/is_admin/
--    manager_id.
--
-- VIDITELNOST: bez peněz. Alokace nese hodiny a období, žádné částky ani
-- sazby, proto je (na rozdíl od deal/subscription z 0058) viditelná celému
-- týmu. Dodávky i případy už tým vidí. Kdyby jednou přibyla hodinová
-- sazba nebo cena práce, patří do samostatné tabulky pod RESTRICTIVE
-- can_see_sales(), ne sem.
--
-- RLS v domácím stylu (0051/0058): permisivní team_all s is_team_member()
-- + RESTRICTIVE require_aal2; volání funkcí zabalená do (SELECT …), ať se
-- vyhodnotí jednou za dotaz. created_by DEFAULT auth.uid() a trigger (vzor
-- engagement_document z 0053): přihlášený uživatel nemůže autora podvrhnout
-- ani přepsat; service_role (bez auth.uid()) je vyjmutá.
--
-- ZÁVISLOSTI: 0002 (team_member, is_team_member), 0001 (engagement),
-- 0005 (is_admin), 0006 (set_updated_at), 0026 (schema_migration),
-- 0039 (work_case). Guard níže skončí srozumitelnou chybou.
-- Idempotentní: ADD COLUMN IF NOT EXISTS, constraint jen když chybí,
-- CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS,
-- ON CONFLICT DO NOTHING. Opakovaný běh je bezpečný.

DO $$
BEGIN
  IF to_regclass('public.team_member') IS NULL
     OR to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje tabulku team_member a funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regclass('public.engagement') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje tabulku engagement — nejdřív aplikujte 0001_base_schema.sql';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje funkci is_admin() — nejdřív aplikujte 0005_admin_flag.sql';
  END IF;
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje funkci set_updated_at() — nejdřív aplikujte 0006_tasks_and_calendar.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje tabulku work_case — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0062 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) team_member.weekly_capacity_hours
-- ===========================================================================

ALTER TABLE team_member
  ADD COLUMN IF NOT EXISTS weekly_capacity_hours numeric(4,1) NOT NULL DEFAULT 40;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.team_member'::regclass
                    AND conname = 'team_member_weekly_capacity_check') THEN
    ALTER TABLE team_member
      ADD CONSTRAINT team_member_weekly_capacity_check
      CHECK (weekly_capacity_hours >= 0 AND weekly_capacity_hours <= 80);
  END IF;
END $$;

-- ===========================================================================
-- 2) allocation
-- ===========================================================================

CREATE TABLE IF NOT EXISTS allocation (
  id              bigserial PRIMARY KEY,
  member_id       uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE,
  engagement_id   bigint REFERENCES engagement(id) ON DELETE CASCADE,
  work_case_id    bigint REFERENCES work_case(id) ON DELETE CASCADE,
  hours_per_week  numeric(4,1) NOT NULL,
  starts_on       date NOT NULL,
  ends_on         date,
  substitute_id   uuid REFERENCES team_member(id) ON DELETE SET NULL,
  note            text,
  created_by      uuid DEFAULT auth.uid() REFERENCES team_member(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Přesně jeden cíl: dodávka NEBO případ.
  CONSTRAINT allocation_one_target CHECK (num_nonnulls(engagement_id, work_case_id) = 1),
  CONSTRAINT allocation_hours_check CHECK (hours_per_week > 0 AND hours_per_week <= 80),
  CONSTRAINT allocation_period_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  -- Zástup musí být jiný člověk (jinak by zástup neexistoval).
  CONSTRAINT allocation_substitute_differs CHECK (substitute_id IS NULL OR substitute_id <> member_id),
  CONSTRAINT allocation_note_check CHECK (note IS NULL OR char_length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS allocation_member_idx ON allocation (member_id, starts_on);
CREATE INDEX IF NOT EXISTS allocation_engagement_idx ON allocation (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS allocation_work_case_idx ON allocation (work_case_id) WHERE work_case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS allocation_substitute_idx ON allocation (substitute_id) WHERE substitute_id IS NOT NULL;

DROP TRIGGER IF EXISTS allocation_set_updated_at ON allocation;
CREATE TRIGGER allocation_set_updated_at BEFORE UPDATE ON allocation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Autor = přihlášený uživatel (vzor engagement_document_enforce_created_by
-- z 0053). Trigger nečte jiné tabulky, SECURITY DEFINER nepotřebuje.
CREATE OR REPLACE FUNCTION allocation_enforce_created_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role / migrace nemají auth.uid() → vyjmuté.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by musí být přihlášený uživatel' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    -- Vynulování (ON DELETE SET NULL po odchodu člověka) projde; přepsat
    -- autora na někoho jiného ne.
    RAISE EXCEPTION 'created_by nelze změnit' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS allocation_created_by ON allocation;
CREATE TRIGGER allocation_created_by
  BEFORE INSERT OR UPDATE ON allocation
  FOR EACH ROW EXECUTE FUNCTION allocation_enforce_created_by();

ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_all ON allocation;
CREATE POLICY team_all ON allocation
  FOR ALL
  USING ((SELECT is_team_member()))
  WITH CHECK ((SELECT is_team_member()));

DROP POLICY IF EXISTS require_aal2 ON allocation;
CREATE POLICY require_aal2 ON allocation
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON allocation FROM anon;

-- ===========================================================================
-- 3) set_weekly_capacity — změna kapacity (admin/vedeni komukoli, jinak sobě)
-- ===========================================================================

CREATE OR REPLACE FUNCTION set_weekly_capacity(p_member_id uuid, p_hours numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_hours  numeric;
BEGIN
  -- SECURITY DEFINER obchází RLS včetně RESTRICTIVE AAL2 → brána tady.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Nepřihlášený uživatel' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'Vyžadováno dvoufázové ověření (AAL2)' USING ERRCODE = '42501';
  END IF;
  IF NOT is_team_member() THEN
    RAISE EXCEPTION 'Jen pro člena týmu' USING ERRCODE = '42501';
  END IF;
  IF p_member_id IS NULL OR p_hours IS NULL THEN
    RAISE EXCEPTION 'Chybí člen týmu nebo počet hodin' USING ERRCODE = '22023';
  END IF;
  v_hours := round(p_hours, 1);
  IF v_hours < 0 OR v_hours > 80 THEN
    RAISE EXCEPTION 'Kapacita musí být 0–80 hodin týdně' USING ERRCODE = '22023';
  END IF;
  IF p_member_id <> v_uid
     AND NOT is_admin()
     AND NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = v_uid AND tm.role::text = 'vedeni') THEN
    RAISE EXCEPTION 'Kapacitu kolegy smí měnit jen vedení nebo admin' USING ERRCODE = '42501';
  END IF;
  UPDATE team_member SET weekly_capacity_hours = v_hours WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Člen týmu neexistuje' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_hours;
END $$;

REVOKE ALL ON FUNCTION set_weekly_capacity(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_weekly_capacity(uuid, numeric) TO authenticated;

-- ===========================================================================
-- 4) team_member: žádný UPDATE přes uživatelskou session (viz hlavička)
-- ===========================================================================

DROP POLICY IF EXISTS team_self ON team_member;
REVOKE UPDATE ON team_member FROM authenticated, anon;

INSERT INTO schema_migration (version, note)
VALUES ('0062', 'kapacity: team_member.weekly_capacity_hours (0-80, default 40), allocation (clen -> dodavka nebo pripad, hodiny/tyden, obdobi, zastup), set_weekly_capacity RPC, team_self zrusena + REVOKE UPDATE team_member')
ON CONFLICT (version) DO NOTHING;
