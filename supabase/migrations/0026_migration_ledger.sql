-- 0026 — Evidence aplikovaných migrací.
--
-- Do teď se 25 migrací pustilo ručně přes Management API a nikde nezůstal
-- záznam, která z nich už proběhla. Dopady: (a) po přerušeném běhu nešlo
-- poznat, kde se to zastavilo, (b) nikdo nezjistí, jestli produkce odpovídá
-- souborům v repu, (c) obnova databáze od nuly je hádání.
--
-- Zpětný zápis 0001–0025 je podložený: existence objektů, které jednotlivé
-- migrace zakládají, byla ověřena proti information_schema, než se sem
-- zapsaly jako hotové.
CREATE TABLE IF NOT EXISTS schema_migration (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  note       text
);

-- Stejně jako api_key: RLS zapnuté, nula politik — přes běžného uživatele
-- nedostupné, sahá na to jen servisní klíč.
ALTER TABLE schema_migration ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migration (version, note) VALUES
  ('0001','základ schématu'),('0002',null),('0003',null),('0004',null),
  ('0005',null),('0006','úkoly a kalendář'),('0007',null),('0008',null),
  ('0009',null),('0010',null),('0011',null),('0012',null),('0013',null),
  ('0014','role v týmu'),('0015',null),('0016',null),('0017','API klíče'),
  ('0018',null),('0019','kontakt u partnera'),('0020','sales CRM'),
  ('0021','aktivita u partnera'),('0022','plánované schůzky a eskalace'),
  ('0023','brány kvality dodávky'),('0024','mezery v zabezpečení'),
  ('0025','oprava v_account_rollup'),
  ('0026','evidence migrací')
ON CONFLICT (version) DO NOTHING;
