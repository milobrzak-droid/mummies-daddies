-- 0059 — touch_deal_last_activity jako SECURITY DEFINER.
--
-- PROČ: trigger sales_activity_touch_deal (0020) po zápisu aktivity
-- posouvá deal.last_activity_at. Funkce dosud běžela s právy toho, kdo
-- aktivitu zapsal. Od 0058 má deal RESTRICTIVE politiku sales_only
-- (can_see_sales()), takže když aktivitu k obchodu zapíše někdo bez obchodní
-- role, UPDATE deal uvnitř triggeru pod RLS nenajde žádný řádek a tiše nic
-- neudělá — obchod pak vypadá „zanedbaný", i když se s klientem mluvilo,
-- a hlídač follow-upů (domain/crm/followUp.ts) připomíná zbytečně.
--
-- CO SE MĚNÍ: jen to, pod kým funkce běží. SECURITY DEFINER (vlastník
-- funkce = vlastník tabulky deal, RLS se ho netýká) a pevný
-- search_path = public, pg_temp (pg_temp poslední, ať si volající nemůže
-- podstrčit vlastní tabulku deal v dočasném schématu). Tělo je beze změny
-- oproti 0020: přesně jeden UPDATE jednoho sloupce last_activity_at
-- u obchodu, na který aktivita odkazuje. Nic dalšího z obchodu nečte ani
-- nevrací, takže volajícímu neprozradí žádná obchodní data.
--
-- Trigger sales_activity_touch_deal se nemění — CREATE OR REPLACE FUNCTION
-- zachová jeho vazbu na funkci. Opakovaný běh je bezpečný (idempotentní).

CREATE OR REPLACE FUNCTION touch_deal_last_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    UPDATE deal
    SET last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.deal_id;
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migration (version, note)
VALUES ('0059', 'touch_deal_last_activity SECURITY DEFINER + search_path public, pg_temp (aktivita ne-obchodní role posune deal.last_activity_at i pod 0058 RLS)')
ON CONFLICT (version) DO NOTHING;
