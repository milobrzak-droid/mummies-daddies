-- 0035 — zpevnění auditu obchodu (deal): vznik, smazání, peníze mimo částku,
-- a pg_temp na SECURITY DEFINER funkcích.
--
-- Bezpečnostní review "Cockpit" našlo v auditu z 0034 čtyři mezery.
-- Tahle migrace je řeší; nic z toho nemění chování appky (žádné .ts se
-- nedotýká) — jen přidává řádky do audit_event a zpevňuje funkce.
--
-- (a) INSERT a DELETE na `deal`. 0034 hlídá jen UPDATE, takže obchod, který
--     někdo (nebo kaskáda z `account ON DELETE CASCADE`) smaže nebo založí
--     napřímo, nezanechal žádnou stopu. Nová funkce deal_audit_insert_delete()
--     zapisuje akce `deal.created` a `deal.deleted`. before/after nese jen
--     smysluplná pole: account_id, title, stage, amount_one_time, currency,
--     expected_mrr. account_id a title jsou tam záměrně i při smazání —
--     řádek už neexistuje, bez nich by z audit_event nešlo poznat, čí obchod
--     zmizel. U `deal.created` je before = NULL, u `deal.deleted` after = NULL.
--     Pozor: hromadný import/seed obchodů teď vyprodukuje jeden audit řádek
--     na obchod; smazání účtu vyprodukuje řádek za každý jeho obchod.
--
--     Sloupec `amount_recurring` v tabulce `deal` NEEXISTUJE (ověřeno v
--     0001–0034). Opakovaná část obchodu je jen `expected_mrr` (0001), proto
--     ho snímek používá místo něj. Skutečné MRR žije v `subscription.mrr`,
--     ne v `deal`, takže je mimo rozsah tohohle triggeru.
--
-- (b) Peněžní sloupce mimo amount_one_time. UPDATE trigger z 0034 reagoval
--     jen na amount_one_time a stage, takže tichá změna měny, kurzu, nákladů
--     nebo dotace (ovlivňují marži a client_paid_one_time) audit obešla.
--     Nově se v WHEN i v těle sleduje: currency, fx_rate,
--     amount_one_time_original, cogs_one_time, subsidy_pct, expected_mrr.
--     Všech šest sloupců v tabulce `deal` existuje (currency, fx_rate,
--     amount_one_time_original z 0016; cogs_one_time, subsidy_pct,
--     expected_mrr z 0001) — žádný jsem nemusel vynechat. Změna se zapíše
--     jako JEDEN řádek `deal.money_changed`, jehož before/after obsahuje
--     jen ty z těchto sloupců, které se opravdu změnily. Chování akcí
--     `deal.amount_changed` a `deal.stage_changed` je beze změny (stejné
--     klíče, stejný tvar); změna amount_one_time se tedy dál zapisuje
--     výhradně jako `deal.amount_changed`, ne do money_changed.
--
-- (c) search_path. SECURITY DEFINER funkce z 0031 a 0034 měly search_path bez
--     pg_temp na konci. Postgres bez explicitní zmínky prohledává pg_temp
--     jako PRVNÍ, takže uživatel s právem CREATE v dočasném schématu by tam
--     mohl podstrčit objekt (tabulku/funkci/operátor) se stejným jménem a
--     funkce běžící jako postgres by ho použila. Explicitní pg_temp jako
--     POSLEDNÍ prvek to zavře.
--       * 0034 (deal_audit_price_stage): search_path = public, pg_temp —
--         nastaveno přímo v CREATE OR REPLACE níž.
--       * 0031 (tři calendar_token_* funkce): search_path = public,
--         extensions, pg_temp. `extensions` se ZÁMĚRNĚ nechává — funkce
--         volají pgp_sym_encrypt/pgp_sym_decrypt bez schématu a bez
--         `extensions` by přestaly fungovat. Ke stavu z 0031 se přidává
--         jen pg_temp na konec. Signatury jsou přesně z CREATE FUNCTION
--         v 0031; ALTER je v DO bloku s kontrolou to_regprocedure, aby
--         migrace nespadla tam, kde 0031 (ještě) neběželo.
--
-- (d) OPRAVA nepravdivého tvrzení z 0034. Tamní hlavička říká, že "v celé
--     appce existuje jediné místo, které mění amount_one_time nebo stage
--     u existujícího obchodu — updateDeal". To neplatí: lib/actions/sales.ts
--     → updateDealStage() taky mění `stage` (a s ní probability_pct,
--     forecast_category, closed_at, won_at, lost_reason...). Nic se tím
--     nerozbíjí: trigger visí na tabulce, ne na konkrétní akci, takže
--     `deal.stage_changed` zachytí OBĚ cesty (updateDeal i updateDealStage)
--     stejně jako přímý zápis. Jen komentář v 0034 nebyl přesný; ten soubor
--     se nemění (migrace se po aplikaci nepřepisují), oprava je tady.
--
-- Aktér a SECURITY DEFINER logika je stejná jako v 0034 (auth.uid() →
-- 'user', jinak 'system' / 'db-trigger:<role>'). Zámky: CREATE OR REPLACE
-- FUNCTION a ALTER FUNCTION berou jen krátký katalogový zámek; DROP/CREATE
-- TRIGGER bere na `deal` SHARE ROW EXCLUSIVE na zlomek sekundy (malá tabulka).

-- (b) UPDATE: stejná funkce jako v 0034, rozšířená o money_changed.
CREATE OR REPLACE FUNCTION deal_audit_price_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_type   text;
  v_actor_id     text;
  v_money_before jsonb := '{}'::jsonb;
  v_money_after  jsonb := '{}'::jsonb;
  v_money_dirty  boolean := false;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_actor_type := 'user';
    v_actor_id   := auth.uid()::text;
  ELSE
    v_actor_type := 'system';
    v_actor_id   := 'db-trigger:' || current_user;
  END IF;

  IF OLD.amount_one_time IS DISTINCT FROM NEW.amount_one_time THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES (
      v_actor_type, v_actor_id, 'deal.amount_changed', 'deal', NEW.id,
      jsonb_build_object('amount_one_time', OLD.amount_one_time),
      jsonb_build_object('amount_one_time', NEW.amount_one_time)
    );
  END IF;

  IF OLD.stage IS DISTINCT FROM NEW.stage THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES (
      v_actor_type, v_actor_id, 'deal.stage_changed', 'deal', NEW.id,
      jsonb_build_object('stage', OLD.stage),
      jsonb_build_object('stage', NEW.stage)
    );
  END IF;

  -- Peněžní sloupce mimo amount_one_time: do before/after jen ty změněné.
  IF OLD.currency IS DISTINCT FROM NEW.currency THEN
    v_money_before := v_money_before || jsonb_build_object('currency', OLD.currency);
    v_money_after  := v_money_after  || jsonb_build_object('currency', NEW.currency);
    v_money_dirty  := true;
  END IF;
  IF OLD.fx_rate IS DISTINCT FROM NEW.fx_rate THEN
    v_money_before := v_money_before || jsonb_build_object('fx_rate', OLD.fx_rate);
    v_money_after  := v_money_after  || jsonb_build_object('fx_rate', NEW.fx_rate);
    v_money_dirty  := true;
  END IF;
  IF OLD.amount_one_time_original IS DISTINCT FROM NEW.amount_one_time_original THEN
    v_money_before := v_money_before || jsonb_build_object('amount_one_time_original', OLD.amount_one_time_original);
    v_money_after  := v_money_after  || jsonb_build_object('amount_one_time_original', NEW.amount_one_time_original);
    v_money_dirty  := true;
  END IF;
  IF OLD.cogs_one_time IS DISTINCT FROM NEW.cogs_one_time THEN
    v_money_before := v_money_before || jsonb_build_object('cogs_one_time', OLD.cogs_one_time);
    v_money_after  := v_money_after  || jsonb_build_object('cogs_one_time', NEW.cogs_one_time);
    v_money_dirty  := true;
  END IF;
  IF OLD.subsidy_pct IS DISTINCT FROM NEW.subsidy_pct THEN
    v_money_before := v_money_before || jsonb_build_object('subsidy_pct', OLD.subsidy_pct);
    v_money_after  := v_money_after  || jsonb_build_object('subsidy_pct', NEW.subsidy_pct);
    v_money_dirty  := true;
  END IF;
  IF OLD.expected_mrr IS DISTINCT FROM NEW.expected_mrr THEN
    v_money_before := v_money_before || jsonb_build_object('expected_mrr', OLD.expected_mrr);
    v_money_after  := v_money_after  || jsonb_build_object('expected_mrr', NEW.expected_mrr);
    v_money_dirty  := true;
  END IF;

  IF v_money_dirty THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES (
      v_actor_type, v_actor_id, 'deal.money_changed', 'deal', NEW.id,
      v_money_before, v_money_after
    );
  END IF;

  RETURN NEW;
END;
$$;

-- WHEN musí odpovídat tělu: bez něj by se funkce volala při každém UPDATE
-- (last_activity_at, updated_at...) zbytečně. Trigger se přeskládá, aby
-- WHEN dostal nové sloupce (CREATE OR REPLACE TRIGGER by šlo taky, ale
-- DROP IF EXISTS + CREATE je vzor z 0034).
DROP TRIGGER IF EXISTS deal_audit_price_stage_trigger ON deal;
CREATE TRIGGER deal_audit_price_stage_trigger
  AFTER UPDATE ON deal
  FOR EACH ROW
  WHEN (
    OLD.amount_one_time          IS DISTINCT FROM NEW.amount_one_time
    OR OLD.stage                 IS DISTINCT FROM NEW.stage
    OR OLD.currency              IS DISTINCT FROM NEW.currency
    OR OLD.fx_rate               IS DISTINCT FROM NEW.fx_rate
    OR OLD.amount_one_time_original IS DISTINCT FROM NEW.amount_one_time_original
    OR OLD.cogs_one_time         IS DISTINCT FROM NEW.cogs_one_time
    OR OLD.subsidy_pct           IS DISTINCT FROM NEW.subsidy_pct
    OR OLD.expected_mrr          IS DISTINCT FROM NEW.expected_mrr
  )
  EXECUTE FUNCTION deal_audit_price_stage();

-- (a) INSERT / DELETE.
CREATE OR REPLACE FUNCTION deal_audit_insert_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_type text;
  v_actor_id   text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_actor_type := 'user';
    v_actor_id   := auth.uid()::text;
  ELSE
    v_actor_type := 'system';
    v_actor_id   := 'db-trigger:' || current_user;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES (
      v_actor_type, v_actor_id, 'deal.created', 'deal', NEW.id,
      NULL,
      jsonb_build_object(
        'account_id', NEW.account_id, 'title', NEW.title, 'stage', NEW.stage,
        'amount_one_time', NEW.amount_one_time, 'currency', NEW.currency,
        'expected_mrr', NEW.expected_mrr
      )
    );
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
    VALUES (
      v_actor_type, v_actor_id, 'deal.deleted', 'deal', OLD.id,
      jsonb_build_object(
        'account_id', OLD.account_id, 'title', OLD.title, 'stage', OLD.stage,
        'amount_one_time', OLD.amount_one_time, 'currency', OLD.currency,
        'expected_mrr', OLD.expected_mrr
      ),
      NULL
    );
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS deal_audit_insert_delete_trigger ON deal;
CREATE TRIGGER deal_audit_insert_delete_trigger
  AFTER INSERT OR DELETE ON deal
  FOR EACH ROW
  EXECUTE FUNCTION deal_audit_insert_delete();

-- (c) pg_temp poslední na funkcích z 0031 (deal_audit_price_stage z 0034 je
-- vyřešená výše přímo v definici). Signatury přesně z CREATE FUNCTION v 0031.
DO $$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'calendar_token_get_decrypted(uuid)',
    'calendar_token_upsert_encrypted(uuid, text, text, text, timestamptz, text)',
    'calendar_token_update_tokens(uuid, text, text, timestamptz)'
  ] LOOP
    IF to_regprocedure('public.' || v_sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s SET search_path = public, extensions, pg_temp', v_sig);
    ELSE
      RAISE NOTICE '0035: funkce public.% neexistuje - preskakuji (0031 nebezelo?)', v_sig;
    END IF;
  END LOOP;
END $$;

INSERT INTO schema_migration (version, note)
VALUES ('0035', 'deal audit hardening - deal.created/deleted, deal.money_changed (currency, fx_rate, amount_one_time_original, cogs_one_time, subsidy_pct, expected_mrr), pg_temp v search_path')
ON CONFLICT (version) DO NOTHING;
