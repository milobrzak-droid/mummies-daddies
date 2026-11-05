-- 0048 — cílové seznamy (PLAN-PRESTAVBY kap. 4).
--
-- target_list: segment + proč oslovit + hypotéza hodnoty. target_list_item:
-- firma v seznamu s důvodem (povinný), koho oslovit (kontakt), dalším krokem
-- a stavem navrzeno → osloveno → odpovedel / vyrazeno.
--
-- Oslovení vytváří aktivitu (sales_activity), NIKDY obchod — to hlídá
-- aplikační vrstva (domain/crm/actions/targetLists.ts); tady žádný trigger
-- na deal není a být nemá.
--
-- RLS domácí styl: permisivní can_see_sales() (jako sales_activity v 0020)
-- + RESTRICTIVE AAL2. Idempotentní (IF NOT EXISTS, DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS target_list (
  id                bigserial PRIMARY KEY,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  segment           text NOT NULL CHECK (length(btrim(segment)) BETWEEN 1 AND 200),
  rationale         text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 4000),
  value_hypothesis  text CHECK (value_hypothesis IS NULL OR length(value_hypothesis) <= 4000),
  owner_id          uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS target_list_item (
  id             bigserial PRIMARY KEY,
  list_id        bigint NOT NULL REFERENCES target_list(id) ON DELETE CASCADE,
  account_id     bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  contact_id     bigint REFERENCES contact(id) ON DELETE SET NULL,
  next_step      text CHECK (next_step IS NULL OR length(next_step) <= 500),
  next_step_due  date,
  status         text NOT NULL DEFAULT 'navrzeno'
                 CHECK (status IN ('navrzeno', 'osloveno', 'odpovedel', 'vyrazeno')),
  created_by     uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT target_list_item_list_account_key UNIQUE (list_id, account_id)
);

CREATE INDEX IF NOT EXISTS target_list_item_account_idx ON target_list_item(account_id);

ALTER TABLE target_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_list_item ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS target_list_all ON target_list;
CREATE POLICY target_list_all ON target_list FOR ALL
  USING (can_see_sales()) WITH CHECK (can_see_sales());

DROP POLICY IF EXISTS target_list_item_all ON target_list_item;
CREATE POLICY target_list_item_all ON target_list_item FOR ALL
  USING (can_see_sales()) WITH CHECK (can_see_sales());

DROP POLICY IF EXISTS require_aal2 ON target_list;
CREATE POLICY require_aal2 ON target_list
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

DROP POLICY IF EXISTS require_aal2 ON target_list_item;
CREATE POLICY require_aal2 ON target_list_item
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON target_list FROM anon;
REVOKE ALL ON target_list_item FROM anon;

INSERT INTO schema_migration (version, note)
VALUES ('0048', 'target_list + target_list_item - cilove seznamy (osloveni = aktivita, ne obchod)')
ON CONFLICT (version) DO NOTHING;
