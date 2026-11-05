-- 0088 — hlavní metrika dopadu dodávky (P1.3) a předání práce člověka
-- (změna vlastníka / odchod z týmu).
--
-- Revize stavu 29. 9. 2026 (P1.3 a „Týmový provoz a zastupitelnost"):
--   * předávací položka „Výchozí metrika" se dosud brala jen z pole
--     engagement.baseline_adoption_pct (0001, Copilot adopce). U automatizace,
--     AI agenta nebo vzdělávání bez adopce vznikala falešná „adopce 0 %"
--     (lidé psali nulu, aby šla dodávka předat);
--   * změna vlastníka nechávala osiřelé věci — vlastníka případu, milníku,
--     alokace ani oblasti nešlo při odchodu člověka hromadně předat.
--
-- 1) ENGAGEMENT: HLAVNÍ METRIKA DOPADU
--    impact_metric_key    typ metriky (klíč z COMPANY.impactMetrics.types
--                         v config/mummiesDaddies.ts: cas_na_ukon, pocet_polozek,
--                         chybovost, adopce, uspora_hodin, vlastni). NULL =
--                         výchozí podle druhu dodávky (defaultByKind) — výchozí
--                         se NEUKLÁDÁ, počítá se při čtení, takže změna šablony
--                         platí i pro starší dodávky bez výslovné volby.
--                         CHECK hlídá jen tvar klíče, ne výčet: výčet je
--                         konfigurace firmy (kapitola 11, vzor 0067 — migrace
--                         je stejná pro každou firmu).
--    impact_metric_label  název vlastní metriky (jen u typu „vlastní").
--    impact_metric_unit   jednotka vlastní metriky.
--                         PENÍZE SEM NEPATŘÍ — stejný vzor jako
--                         metric_observation_no_currency_check (0061) a
--                         CURRENCY_PATTERN v domain/delivery/impact.ts.
--    impact_unmeasurable_reason / _at / _by
--                         doložené „zatím nelze měřit": důvod (10–1000 znaků),
--                         kdy a kdo. Kdy a kdo doplní trigger z now()
--                         a auth.uid() — z klienta nejdou podvrhnout (vzor
--                         created_by z 0053/0061). Autor se po odchodu člověka
--                         vynuluje (ON DELETE SET NULL), důvod a čas zůstanou.
--    Výchozí stav a výsledek se berou VÝHRADNĚ z metric_observation (0061):
--    řádek s metric_key = zvolená (nebo výchozí) metrika. Předávací položka
--    „Výchozí metrika" je splněná, když existuje takový řádek s baseline,
--    nebo je vyplněný doložený důvod „zatím nelze měřit"
--    (domain/delivery/impactMetric.ts, handoffBaselineOk).
--
-- 2) METRIC_OBSERVATION.metric_key
--    Ke které hlavní metrice měření patří (stejný tvar klíče). NULL =
--    doplňkové měření mimo hlavní metriku (dosavadní řádky).
--
-- 3) PŘEVOD STARÝCH POLÍ ADOPCE % (jednorázově, idempotentně)
--    Dodávky s vyplněnou adopcí (baseline_adoption_pct / post_adoption_pct)
--    dostanou měření s metric_key 'adopce' (klíč z config/mummiesDaddies.ts, hlídá
--    test/impact-metric.test.ts), ať výchozí stav nezmizí. VÝJIMKA: dodávka
--    jiného druhu než vzdělávání ('edu') s adopcí přesně 0 a bez výsledku —
--    to je obcházení staré kontroly („napsat aspoň nulu"), ne měření; takovou
--    nulu nepřevádíme, jinak by se falešná „adopce 0 %" jen přestěhovala.
--    U převedené dodávky jiného druhu než 'edu' se adopce zapíše jako
--    výslovně zvolená metrika (u 'edu' je výchozí). Počet ohlásí NOTICE;
--    zápis zachytí audit metric_observation (0082, aktér systém). Opakovaný
--    běh nic nezdvojí (NOT EXISTS na metric_key 'adopce').
--    Sloupce adopce v engagement zůstávají (Copilot přehled, scoreboard) —
--    pro předání a dopad se už nepoužívají.
--
-- 4) transfer_member_work(od, komu, aktér, druhy, dnes) — předání práce
--    Jedna transakce: všechny zvolené druhy otevřených věcí člověka přejdou
--    na jiného aktivního člena interní role. Druhy:
--      klienti   account.owner_id
--      obchody   deal.owner_id u otevřených obchodů (ne vyhráno/prohráno/odloženo)
--      dodavky   engagement.owner_id / deputy_id, fáze ≠ uzavreno
--      milniky   engagement_milestone.owner_id / deputy_id, stav ≠ uzavreno
--      ukoly     task.assignee_id, stav ≠ done
--      pripady   work_case.lead_owner_id / deputy_id, stav open/in_progress/waiting
--      alokace   allocation.member_id / substitute_id, běžící nebo budoucí.
--                Budoucí (od dneška) se jen přepíše na nového člověka. Běžící
--                se ukončí včerejškem a od dneška vznikne stejná alokace pro
--                nového člověka — historie kapacity zůstane pravdivá.
--      oblasti   loop_node.owner_id / deputy_id
--    ZASTUPITELNOST: kde by nový vlastník byl zároveň zástupcem (CHECK
--    „zástupce ≠ vlastník"), zástupce se uvolní (NULL) a funkce to spočítá
--    v `bez_zastupce` — aplikace vyzve zástupce doplnit.
--    VOLÁ JEN service_role (lib/actions/team.ts, admin klient s hlavičkou
--    aktéra x-cockpit-audit-actor). Proč ne přihlášený admin přímo: strážce
--    work_case_guard (0057) pouští změnu vlastníka případu jen vedení,
--    vlastníkovi případu nebo oblasti — správce týmu nemusí být ani jedno.
--    Pod service_role (bez auth.uid()) strážce změnu pustí; oprávnění proto
--    ověřuje aplikace (requireAdmin: AAL2 + is_admin z DB) a znovu funkce
--    (p_actor musí být aktivní admin interní role). REVOKE od PUBLIC, anon
--    a authenticated.
--    AUDIT: každý přepsaný řádek zapíše řádkový trigger tabulky (0064/0082)
--    s aktérem z hlavičky; navíc jeden souhrnný řádek
--    'team_member.work_transferred' (entity_table team_member, entity_ref =
--    uuid předávajícího, v after komu, druhy, počty — jen id a čísla).
--    Z něj čte „Co se změnilo" (domain/crm/changes.ts, handoverChanges).
--    Když se nic nepřesunulo, souhrnný řádek nevzniká.
--    Chyby: TW001 špatný vstup (sám sobě), TW002 cílový člověk není aktivní
--    člen interní role / zdroj neexistuje, TW003 aktér není aktivní admin,
--    TW004 neznámý druh. Překlad v lib/memberWork.ts (TRANSFER_ERRORS).
--
-- RLS: nová tabulka nevzniká; nové sloupce dědí RLS engagement (0003/0007)
-- a metric_observation (0061). Funkce je SECURITY DEFINER se search_path.
--
-- Zámky: ADD COLUMN bez DEFAULT = změna katalogu; ADD CONSTRAINT CHECK
-- projde malé tabulky pod ACCESS EXCLUSIVE zlomek sekundy.
--
-- ZÁVISLOSTI: 0039 (work_case, loop_node), 0042 (engagement_milestone),
-- 0061 (metric_observation, engagement.owner_id), 0062 (allocation), 0069
-- (team_member.deactivated_at), 0082 (audit_event.entity_ref), 0026 (ledger).
-- Guard níže skončí srozumitelnou chybou. Idempotentní: ADD COLUMN IF NOT
-- EXISTS, DROP … IF EXISTS + ADD, CREATE OR REPLACE, NOT EXISTS, ON CONFLICT.

DO $$
BEGIN
  IF to_regclass('public.engagement') IS NULL OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0088 vyžaduje engagement a team_member — nejdřív aplikujte 0001 a 0002';
  END IF;
  IF to_regclass('public.metric_observation') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'engagement' AND column_name = 'owner_id') THEN
    RAISE EXCEPTION '0088 vyžaduje metric_observation a engagement.owner_id — nejdřív aplikujte 0061_delivery_impact.sql';
  END IF;
  IF to_regclass('public.work_case') IS NULL OR to_regclass('public.loop_node') IS NULL THEN
    RAISE EXCEPTION '0088 vyžaduje work_case a loop_node — nejdřív aplikujte 0039_loop_core.sql';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0088 vyžaduje engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
  IF to_regclass('public.allocation') IS NULL THEN
    RAISE EXCEPTION '0088 vyžaduje allocation — nejdřív aplikujte 0062_capacity.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'team_member' AND column_name = 'deactivated_at') THEN
    RAISE EXCEPTION '0088 vyžaduje team_member.deactivated_at — nejdřív aplikujte 0069_security_fixes.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'entity_ref') THEN
    RAISE EXCEPTION '0088 vyžaduje audit_event.entity_ref — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0088 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

-- ===========================================================================
-- 1) engagement: hlavní metrika dopadu
-- ===========================================================================

ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_metric_key text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_metric_label text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_metric_unit text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_unmeasurable_reason text;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_unmeasurable_at timestamptz;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS impact_unmeasurable_by uuid
  REFERENCES team_member(id) ON DELETE SET NULL;

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_impact_metric_key_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_impact_metric_key_check
  CHECK (impact_metric_key IS NULL OR impact_metric_key ~ '^[a-z][a-z0-9_]{0,39}$');

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_impact_metric_label_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_impact_metric_label_check
  CHECK (impact_metric_label IS NULL OR char_length(btrim(impact_metric_label)) BETWEEN 1 AND 100);

ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_impact_metric_unit_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_impact_metric_unit_check
  CHECK (impact_metric_unit IS NULL OR char_length(btrim(impact_metric_unit)) BETWEEN 1 AND 30);

-- Vzor = CURRENCY_PATTERN v domain/delivery/impact.ts (hlídá test/impact-metric.test.ts).
ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_impact_no_currency_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_impact_no_currency_check
  CHECK (
    lower(coalesce(impact_metric_label, '')) !~ '[€$£]|(^|[^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž])(czk|kč|kc|eur|euro|eura|usd|gbp|chf|pln|korun|koruna|koruny)([^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž]|$)'
    AND lower(coalesce(impact_metric_unit, '')) !~ '[€$£]|(^|[^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž])(czk|kč|kc|eur|euro|eura|usd|gbp|chf|pln|korun|koruna|koruny)([^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž]|$)'
  );

-- Doložené „zatím nelze měřit" = důvod + kdy (autor smí po odchodu člověka zmizet).
ALTER TABLE engagement DROP CONSTRAINT IF EXISTS engagement_impact_unmeasurable_check;
ALTER TABLE engagement ADD CONSTRAINT engagement_impact_unmeasurable_check
  CHECK (
    (impact_unmeasurable_reason IS NULL AND impact_unmeasurable_at IS NULL AND impact_unmeasurable_by IS NULL)
    OR (impact_unmeasurable_reason IS NOT NULL
        AND char_length(btrim(impact_unmeasurable_reason)) BETWEEN 10 AND 1000
        AND impact_unmeasurable_at IS NOT NULL)
  );

-- Kdy a kdo u „nelze měřit" z DB, ne z klienta. Změna důvodu = nové razítko;
-- bez změny důvodu se razítko nepřepíše (vynulování autora po ON DELETE
-- SET NULL projde).
CREATE OR REPLACE FUNCTION engagement_impact_unmeasurable_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.impact_unmeasurable_reason IS DISTINCT FROM OLD.impact_unmeasurable_reason THEN
    IF NEW.impact_unmeasurable_reason IS NULL THEN
      NEW.impact_unmeasurable_at := NULL;
      NEW.impact_unmeasurable_by := NULL;
    ELSE
      NEW.impact_unmeasurable_at := now();
      NEW.impact_unmeasurable_by := auth.uid();
    END IF;
  ELSE
    NEW.impact_unmeasurable_at := OLD.impact_unmeasurable_at;
    IF NEW.impact_unmeasurable_by IS NOT NULL THEN
      NEW.impact_unmeasurable_by := OLD.impact_unmeasurable_by;
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION engagement_impact_unmeasurable_stamp() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS engagement_impact_unmeasurable_stamp ON engagement;
CREATE TRIGGER engagement_impact_unmeasurable_stamp
  BEFORE INSERT OR UPDATE ON engagement
  FOR EACH ROW EXECUTE FUNCTION engagement_impact_unmeasurable_stamp();

COMMENT ON COLUMN engagement.impact_metric_key IS
  'Hlavní metrika dopadu (klíč z COMPANY.impactMetrics); NULL = výchozí podle druhu dodávky.';
COMMENT ON COLUMN engagement.impact_unmeasurable_reason IS
  'Doložené „zatím nelze měřit" — důvod; kdy a kdo doplní trigger engagement_impact_unmeasurable_stamp.';

-- ===========================================================================
-- 2) metric_observation.metric_key
-- ===========================================================================

ALTER TABLE metric_observation ADD COLUMN IF NOT EXISTS metric_key text;

ALTER TABLE metric_observation DROP CONSTRAINT IF EXISTS metric_observation_metric_key_check;
ALTER TABLE metric_observation ADD CONSTRAINT metric_observation_metric_key_check
  CHECK (metric_key IS NULL OR metric_key ~ '^[a-z][a-z0-9_]{0,39}$');

CREATE INDEX IF NOT EXISTS metric_observation_engagement_key_idx
  ON metric_observation(engagement_id, metric_key) WHERE metric_key IS NOT NULL;

COMMENT ON COLUMN metric_observation.metric_key IS
  'Ke které hlavní metrice měření patří (engagement.impact_metric_key nebo výchozí); NULL = doplňkové měření.';

-- ===========================================================================
-- 3) převod starých polí Adopce %
-- ===========================================================================

DO $$
DECLARE
  v_rows integer;
  v_keys integer;
BEGIN
  INSERT INTO metric_observation (engagement_id, metric, unit, baseline, actual, observed_on, note, metric_key)
  SELECT e.id, 'Adopce', '%', e.baseline_adoption_pct, e.post_adoption_pct,
         coalesce(e.baseline_captured_on, e.post_captured_on, e.created_at::date),
         'Převzato z polí Adopce % dodávky (migrace 0088).', 'adopce'
    FROM engagement e
   WHERE (e.baseline_adoption_pct IS NOT NULL OR e.post_adoption_pct IS NOT NULL)
     AND NOT (e.kind <> 'edu' AND e.baseline_adoption_pct = 0 AND e.post_adoption_pct IS NULL)
     AND NOT EXISTS (SELECT 1 FROM metric_observation m
                      WHERE m.engagement_id = e.id AND m.metric_key = 'adopce');
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  UPDATE engagement e
     SET impact_metric_key = 'adopce'
   WHERE e.impact_metric_key IS NULL
     AND e.kind <> 'edu'
     AND EXISTS (SELECT 1 FROM metric_observation m
                  WHERE m.engagement_id = e.id AND m.metric_key = 'adopce');
  GET DIAGNOSTICS v_keys = ROW_COUNT;

  IF v_rows > 0 OR v_keys > 0 THEN
    RAISE NOTICE '0088: převedeno % měření adopce, % dodávkám jiného druhu nastavena metrika adopce', v_rows, v_keys;
  END IF;
END $$;

-- ===========================================================================
-- 4) transfer_member_work — předání práce člověka
-- ===========================================================================

CREATE OR REPLACE FUNCTION transfer_member_work(
  p_from uuid,
  p_to uuid,
  p_actor uuid,
  p_kinds text[],
  p_today date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed  constant text[] := ARRAY['klienti', 'obchody', 'dodavky', 'milniky', 'ukoly', 'pripady', 'alokace', 'oblasti'];
  v_internal constant text[] := ARRAY['vedeni', 'obchodnik', 'projektak', 'lektor'];
  v_counts   jsonb := '{}'::jsonb;
  v_freed    integer := 0;
  v_n        integer;
  v_m        integer;
  v_total    integer := 0;
  r          record;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_actor IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'Chybí, od koho a komu se práce předává' USING ERRCODE = 'TW001';
  END IF;
  IF p_from = p_to THEN
    RAISE EXCEPTION 'Práci nejde předat témuž člověku' USING ERRCODE = 'TW001';
  END IF;
  IF p_kinds IS NULL OR cardinality(p_kinds) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_kinds) AS k WHERE k IS NULL OR NOT (k = ANY (v_allowed))) THEN
    RAISE EXCEPTION 'Neznámý druh předávané práce' USING ERRCODE = 'TW004';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.id = p_actor AND tm.is_admin AND tm.deactivated_at IS NULL
                    AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Předat práci smí jen aktivní správce týmu' USING ERRCODE = 'TW003';
  END IF;

  -- Souběžná předání téhož člověka se seřadí.
  PERFORM 1 FROM team_member tm WHERE tm.id IN (p_from, p_to) ORDER BY tm.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = p_from) THEN
    RAISE EXCEPTION 'Člověk, od kterého se předává, neexistuje' USING ERRCODE = 'TW002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.id = p_to AND tm.deactivated_at IS NULL AND tm.role::text = ANY (v_internal)) THEN
    RAISE EXCEPTION 'Práci jde předat jen aktivnímu členovi týmu s interní rolí' USING ERRCODE = 'TW002';
  END IF;

  IF 'klienti' = ANY (p_kinds) THEN
    UPDATE account SET owner_id = p_to WHERE owner_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('klienti', v_n);
  END IF;

  IF 'obchody' = ANY (p_kinds) THEN
    UPDATE deal SET owner_id = p_to
     WHERE owner_id = p_from AND stage::text NOT IN ('vyhráno', 'prohráno', 'odloženo');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('obchody', v_n);
  END IF;

  IF 'dodavky' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM engagement
     WHERE phase::text <> 'uzavreno'
       AND ((owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE engagement
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from AND phase::text <> 'uzavreno';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE engagement
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND phase::text <> 'uzavreno';
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('dodavky', v_n + v_m);
  END IF;

  IF 'milniky' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM engagement_milestone
     WHERE status <> 'uzavreno'
       AND ((owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE engagement_milestone
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from AND status <> 'uzavreno';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE engagement_milestone
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND status <> 'uzavreno';
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('milniky', v_n + v_m);
  END IF;

  IF 'ukoly' = ANY (p_kinds) THEN
    UPDATE task SET assignee_id = p_to WHERE assignee_id = p_from AND status::text <> 'done';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('ukoly', v_n);
  END IF;

  IF 'pripady' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM work_case
     WHERE status IN ('open', 'in_progress', 'waiting')
       AND ((lead_owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND lead_owner_id = p_to));
    v_freed := v_freed + v_m;
    UPDATE work_case
       SET lead_owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE lead_owner_id = p_from AND status IN ('open', 'in_progress', 'waiting');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE work_case
       SET deputy_id = CASE WHEN lead_owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from AND status IN ('open', 'in_progress', 'waiting');
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('pripady', v_n + v_m);
  END IF;

  IF 'alokace' = ANY (p_kinds) THEN
    v_n := 0;
    -- Budoucí (od dneška): jen jiný člověk.
    UPDATE allocation
       SET member_id = p_to,
           substitute_id = CASE WHEN substitute_id = p_to THEN NULL ELSE substitute_id END
     WHERE member_id = p_from AND starts_on >= p_today;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_n := v_n + v_m;
    -- Běžící: ukončit včerejškem, od dneška totéž pro nového člověka.
    FOR r IN
      SELECT a.id, a.engagement_id, a.work_case_id, a.hours_per_week, a.ends_on, a.substitute_id, a.note
        FROM allocation a
       WHERE a.member_id = p_from AND a.starts_on < p_today
         AND (a.ends_on IS NULL OR a.ends_on >= p_today)
       ORDER BY a.id
       FOR UPDATE
    LOOP
      UPDATE allocation SET ends_on = p_today - 1 WHERE id = r.id;
      INSERT INTO allocation (member_id, engagement_id, work_case_id, hours_per_week, starts_on, ends_on,
                              substitute_id, note, created_by)
      VALUES (p_to, r.engagement_id, r.work_case_id, r.hours_per_week, p_today, r.ends_on,
              CASE WHEN r.substitute_id = p_to THEN NULL ELSE r.substitute_id END, r.note, p_actor);
      v_n := v_n + 1;
    END LOOP;
    -- Zástup v běžících a budoucích alokacích.
    UPDATE allocation
       SET substitute_id = CASE WHEN member_id = p_to THEN NULL ELSE p_to END
     WHERE substitute_id = p_from AND (ends_on IS NULL OR ends_on >= p_today);
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('alokace', v_n + v_m);
  END IF;

  IF 'oblasti' = ANY (p_kinds) THEN
    SELECT count(*) INTO v_m FROM loop_node
     WHERE (owner_id = p_from AND deputy_id = p_to) OR (deputy_id = p_from AND owner_id = p_to);
    v_freed := v_freed + v_m;
    UPDATE loop_node
       SET owner_id = p_to,
           deputy_id = CASE WHEN deputy_id = p_to THEN NULL ELSE deputy_id END
     WHERE owner_id = p_from;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE loop_node
       SET deputy_id = CASE WHEN owner_id = p_to THEN NULL ELSE p_to END
     WHERE deputy_id = p_from;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('oblasti', v_n + v_m);
  END IF;

  SELECT coalesce(sum(value::integer), 0) INTO v_total FROM jsonb_each_text(v_counts);
  v_counts := v_counts || jsonb_build_object('bez_zastupce', v_freed);

  IF v_total > 0 THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, entity_ref, before, after, info_state)
    VALUES ('user', p_actor::text, 'team_member.work_transferred', 'team_member', NULL, p_from::text,
            jsonb_build_object('member_id', p_from),
            jsonb_build_object('to_member_id', p_to, 'kinds', to_jsonb(p_kinds), 'counts', v_counts, 'on', p_today),
            'human_confirmed');
  END IF;

  RETURN v_counts;
END $$;

REVOKE ALL ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) TO service_role;

COMMENT ON FUNCTION transfer_member_work(uuid, uuid, uuid, text[], date) IS
  'Předání otevřené práce člověka jinému členovi týmu (jedna transakce, souhrn v auditu). Jen service_role.';

INSERT INTO schema_migration (version, note)
VALUES ('0088', 'hlavni metrika dopadu dodavky (typ, vlastni, doložené nelze merit, metric_key) + transfer_member_work (predani prace cloveka)')
ON CONFLICT (version) DO NOTHING;
