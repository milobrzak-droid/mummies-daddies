-- 0012 — Partner má role (může jich mít víc) místo jednoho flagu. Externí vztahy:
-- referrer (doporučovatel) / vendor / distributor. Interní realizační týmy NEjsou
-- partneři → „Rhomates" (= interní tým) se maže.
ALTER TABLE partner ADD COLUMN roles text[] NOT NULL DEFAULT '{}';

UPDATE partner SET roles = array_append(roles, 'referrer')   WHERE is_referrer = true;
UPDATE partner SET roles = array_append(roles, 'vendor')     WHERE name = 'Microsoft';
UPDATE partner SET roles = array_append(roles, 'distributor') WHERE name = 'BETA TRADE';

DELETE FROM partner WHERE name = 'Rhomates';

-- `is_referrer` zůstává jako odvozený/legacy flag (roles @> '{referrer}'); nové UI čte roles.
