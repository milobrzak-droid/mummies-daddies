-- 0045 — atomická změna admin příznaku (set_team_member_admin).
--
-- setParticipantAdmin (lib/actions/team.ts) dosud četl počet adminů a pak
-- zvlášť dělal UPDATE. Dvě souběžné degradace (dva admini se navzájem
-- odeberou) mohly obě projít kontrolou a tým by zůstal bez admina.
--
-- RPC set_team_member_admin(p_user_id, p_is_admin):
--   a) volající musí být přihlášený (auth.uid()), s AAL2 (auth.jwt()->>'aal')
--      a is_admin = true v team_member — jinak SQLSTATE 42501;
--   b) zamkne všechny admin řádky (SELECT … FOR UPDATE), takže souběžné
--      degradace se serializují, a odmítne degradaci, po které by nezbyl
--      žádný admin — SQLSTATE P0001, zpráva 'last_admin';
--   c) provede UPDATE. Neexistující cíl — SQLSTATE P0002 'not_found'.
--
-- EXECUTE jen pro authenticated (volá se klientem s uživatelskou session,
-- kvůli auth.uid()); PUBLIC a anon odebráno.
--
-- POŘADÍ NASAZENÍ: libovolné. Kód při chybějící funkci (PGRST202 / 42883)
-- spadne zpět na dosavadní check-then-update.
--
-- Idempotentní: CREATE OR REPLACE + REVOKE/GRANT + ON CONFLICT.

CREATE OR REPLACE FUNCTION set_team_member_admin(p_user_id uuid, p_is_admin boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_admins uuid[];
BEGIN
  IF p_user_id IS NULL OR p_is_admin IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  IF v_caller IS NULL OR coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Zamknout všechny admin řádky: souběžná volání čekají, než tahle
  -- transakce skončí, a pak vidí už aktualizovaný stav.
  SELECT array_agg(t.id ORDER BY t.id) INTO v_admins
    FROM (SELECT tm.id FROM team_member tm WHERE tm.is_admin ORDER BY tm.id FOR UPDATE) t;

  IF v_admins IS NULL OR NOT (v_caller = ANY (v_admins)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT p_is_admin AND p_user_id = ANY (v_admins) AND cardinality(v_admins) <= 1 THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'P0001',
      HINT = 'Tým musí mít aspoň jednoho administrátora.';
  END IF;

  UPDATE team_member SET is_admin = p_is_admin WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION set_team_member_admin(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_team_member_admin(uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION set_team_member_admin(uuid, boolean) TO authenticated;

INSERT INTO schema_migration (version, note)
VALUES ('0045', 'set_team_member_admin RPC (atomicky guard posledniho admina)')
ON CONFLICT (version) DO NOTHING;
