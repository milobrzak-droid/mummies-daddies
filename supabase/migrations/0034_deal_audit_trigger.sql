-- 0034 — audit ceny/fáze obchodu vynucený v databázi, ne jen v appce.
--
-- Kapitola 3 plánu přestavby (docs/PROVOZ.md), Invariant 3 cílového
-- dokumentu: „změna ceny, fáze, závazku nebo akceptace musí mít původ
-- a oprávněného aktéra" — a to i pro změnu, která appku úplně obejde
-- (raw SQL, budoucí skript se service-role klíčem). Dnešní audit
-- (lib/actions/deals.ts → dealAuditDiff + recordAudit) běží jen uvnitř
-- updateDeal server akce; obejde ho cokoli, co zapíše přímo do `deal`.
--
-- ROZHODNUTÍ: trigger je JEDINÝ zdroj audit_event řádků pro cenu/fázi
-- obchodu — ne bezpečnostní síť vedle appkového volání (varianta (a) ze
-- zadání). Důvod je čistě technický, ne preference:
--
--   Appka mluví s Postgresem přes PostgREST (@supabase/supabase-js) a tam
--   platí JEDEN request = JEDNA transakce, bez afinity mezi requesty.
--   Varianta (a) chtěla, aby appka před vlastním UPDATE nastavila
--   `SET LOCAL app.skip_deal_audit_trigger = 'true'` a trigger tenhle
--   session-local příznak uvnitř téže transakce přečetl a přeskočil.
--   To vyžaduje, aby SET LOCAL a UPDATE běžely ve STEJNÉ transakci — což
--   přes samostatné `.update()` volání supabase-js prostě nejde (žádné
--   RPC, žádné vícepříkazové transakce se dnes v kódu nepoužívají; viz
--   lib/actions/deals.ts, lib/supabase/server.ts). Šlo by to obejít
--   zabalením celého UPDATE do nové RPC funkce, ale to by byl přepis
--   zápisové cesty obchodu kvůli auditu, ne „jeden přidaný řádek", a nese
--   vlastní riziko (viz CENTRÁLNÍ PROBLÉM v zadání).
--
--   Kontrola „byl před chvílí appkou zapsaný audit řádek" taky nefunguje
--   časově: trigger běží BĚHEM transakce UPDATE `deal`, ale appka volá
--   recordAudit AŽ PO jejím úspěšném potvrzení (viz updateDeal) — v
--   okamžiku, kdy trigger běží, appkový audit řádek ještě neexistuje.
--
-- Proto varianta (b): appka (updateDeal) svoje volání dealAuditDiff/
-- recordAudit pro `deal` ZRUŠILA (viz lib/actions/deals.ts) a trigger
-- dělá STEJNOU věc, kterou dělal dealAuditDiff — porovná OLD/NEW po
-- jednotlivých sloupcích a založí `deal.amount_changed` /
-- `deal.stage_changed` se stejným tvarem before/after. Žádná ztráta
-- přesnosti: v celé appce existuje jediné místo, které mění amount_one_time
-- nebo stage u existujícího obchodu — updateDeal (ověřeno grepem přes
-- lib/, app/; REST/MCP zápisová cesta v lib/apiWrite.ts cenu ani fázi
-- záměrně nesmí měnit, viz komentář tamtéž). Trigger tedy nahrazuje jediné
-- volání 1:1, ne aproximuje N různých cest.
--
-- AKTÉR: `auth.uid()` funguje i uvnitř SECURITY DEFINER funkce (jde
-- o request-scoped GUC, ne o roli, ve které funkce běží) a u appkových
-- zápisů spolehlivě vrací UUID přihlášeného člověka — na tom už dnes stojí
-- RLS politiky caltoken_self (0024) a task (0006), takže kdyby auth.uid()
-- za běhu appky nerezolvoval, appka by dávno byla nepoužitelná. Pro zápis
-- mimo appku (service-role klient, psql, budoucí skript) auth.uid() vrací
-- NULL — tam se aktér zapíše jako 'db-trigger:' || current_user, aby šel
-- na první pohled (i bez čtení hodnoty) poznat od appkového 'user' řádku:
-- actor_type je u něj 'system', ne 'user'.
--
-- SECURITY DEFINER: `audit_event` má RLS zapnuté a JEDINOU policy je
-- SELECT pro tým s AAL2 (0028) — žádná INSERT policy, protože appka tam
-- dosud zapisovala jen přes service-role klienta, který RLS obchází.
-- Trigger ale běží v roli toho, kdo zapisuje do `deal` (authenticated přes
-- appku, nebo service_role/postgres při obejití appky) — bez SECURITY
-- DEFINER by INSERT do audit_event spadl na default-deny RLS. Stejný vzor
-- jako handle_new_user (0002) a přístupové funkce k calendar_token (0031):
-- vlastník funkce (postgres) má BYPASSRLS, takže insert projde bez ohledu
-- na to, kdo update na `deal` spustil.

CREATE OR REPLACE FUNCTION deal_audit_price_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_type text;
  v_actor_id   text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_actor_type := 'user';
    v_actor_id   := auth.uid()::text;
  ELSE
    -- Žádný přihlášený uživatel v request kontextu = zápis mimo appku
    -- (service-role klient, přímé SQL, budoucí skript). current_user je
    -- postgresová role, která UPDATE spustila (např. service_role) — ne
    -- jméno člověka, ale jediná identita, která je v DB k dispozici.
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_audit_price_stage_trigger ON deal;
CREATE TRIGGER deal_audit_price_stage_trigger
  AFTER UPDATE ON deal
  FOR EACH ROW
  WHEN (OLD.amount_one_time IS DISTINCT FROM NEW.amount_one_time OR OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION deal_audit_price_stage();

INSERT INTO schema_migration (version, note)
VALUES ('0034', 'deal_audit_price_stage_trigger - audit ceny/faze obchodu vynuceny v DB, jediny zdroj (appka vlastni volani zrusila)')
ON CONFLICT (version) DO NOTHING;
