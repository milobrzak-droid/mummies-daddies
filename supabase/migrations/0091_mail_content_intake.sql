-- 0091 — mail_content_intake: vědomě vybraná pošta s obsahem (P2.1 revize stavu
-- z 29. 9. 2026, kapitola 2D „E-mail dnes neumí dodat stav projektu").
--
-- PROČ: Cockpit z pošty plošně čte jen metadata (0041), takže nepozná, že klient
-- schválil mapu, posunul termín nebo chce změnu. Tahle migrace dává místo
-- OBSAHOVÉMU vstupu, který je výslovně omezený: Viktor přesune e-mail v Outlooku do
-- složky „Cockpit" (název z prostředí) a jen takové zprávy Cockpit přečte včetně
-- těla. Zbytek schránky zůstává metadata. Spuštění: MAIL_CONTENT_INTAKE_ENABLED
-- (výchozí vypnuto), denní cron outlook-mail; kód v domain/crm/mailContent*.ts.
--
-- CO SE UKLÁDÁ (minimalizace)
--   * TĚLO ZPRÁVY SE NEUKLÁDÁ NIKDY. Čte se v paměti jednoho běhu, pravidla
--     (klíčová slova) z něj vytáhnou příznaky a jeden důkazní ÚRYVEK (nejvýš
--     300 znaků, bez e-mailových adres a dlouhých čísel), a tělo se zahodí.
--   * Řádek nese: odkaz na zprávu (evidence, 0038: Message-ID + webLink),
--     doménu odesílatele (ne adresu), předmět (nejvýš 200 znaků), úryvek,
--     NÁZVY příloh (ne obsah), rozpoznané příznaky, návrh data z textu
--     a vazbu na klienta / dodávku / obchod / milník.
--   * Předmět, úryvek a názvy příloh jsou jediný „obsah". Drží je řádek jen
--     dokud je potřeba: čekající řádek 30 dní (pak vyprší), řádek s návrhem
--     do 30 dní po rozhodnutí o návrhu (nejdéle 180 dní), zahozený řádek je
--     bez textu hned. CHECK mail_content_intake_state_consistent to vynucuje
--     v databázi, ne jen v aplikaci; retenci dělá purge_mail_content_intake()
--     (volá ji existující denní cron, jen service_role).
--   * Trvale zůstávají metadata: stav, časy, klient, dodávka, milník, návrh,
--     příznaky, způsob spárování. Zdroj pravdy o obsahu je sama zpráva
--     v Outlooku (odkaz), ne Cockpit.
--
-- CO SE NIKDY NEPROVEDE SÁM: řádek vede maximálně k NÁVRHU (case_proposal, 0067,
-- capability mail_content_*), který přijme nebo zamítne člověk. Milník, termín
-- ani úkol Cockpit sám nezmění. Nejistota (neznámý klient, víc kandidátů,
-- už čekající návrh) = řádek zůstane ve frontě „Pošta k zařazení" (status
-- queued + wait_reason) a čeká na ruční přiřazení, jako nespárované zápisy
-- schůzek (0078).
--
-- OPRÁVNĚNÍ: obsah pošty klientů je obchodní data (jako zápis ze schůzky,
-- 0078): RLS = permisivní SELECT pro tým + RESTRICTIVE sales_only
-- (can_see_sales: vedení, obchodník) + RESTRICTIVE require_aal2. Dodávkové role
-- (projektak, lektor) řádek ani úryvek nevidí; návrh (case_proposal) vidí celý
-- tým, ale jeho zdůvodnění úryvek nenese. Zapisuje jen servisní klíč (cron,
-- server akce po requireUser AAL2 + obchodní roli); authenticated má jen SELECT.
--
-- AUDIT: měkký trigger audit_row_change_soft() (0082, nová tabulka — chyba
-- auditu zápis neshodí): id, stavy, časy, vazby a příznaky s hodnotou;
-- subject, excerpt, attachment_names, sender_domain, proposed_date
-- a dedupe_key jen názvem sloupce. MUSÍ sedět s DB_AUDITED_TABLES.mail_content_intake
-- v core/auditCoverage.ts (test/audit-coverage-0064.test.ts).
--
-- IDEMPOTENCE MIGRACE: IF NOT EXISTS, DROP … IF EXISTS + CREATE, CREATE OR REPLACE,
-- ON CONFLICT. Jen nová tabulka a funkce; žádný zásah do existujících dat.
--
-- ZÁVISLOSTI: 0001 (account, deal, engagement), 0042 (engagement_milestone),
-- 0038 (evidence), 0067 (case_proposal), 0020 (can_see_sales), 0082
-- (audit_row_change_soft), 0026 (ledger). Guard níže skončí srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.account') IS NULL
     OR to_regclass('public.deal') IS NULL
     OR to_regclass('public.engagement') IS NULL
     OR to_regclass('public.team_member') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje tabulky account, deal, engagement a team_member — nejdřív aplikujte starší migrace';
  END IF;
  IF to_regclass('public.engagement_milestone') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje tabulku public.engagement_milestone — nejdřív aplikujte 0042_engagement_milestone.sql';
  END IF;
  IF to_regclass('public.evidence') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje tabulku public.evidence — nejdřív aplikujte 0038_evidence.sql';
  END IF;
  IF to_regclass('public.case_proposal') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje tabulku public.case_proposal — nejdřív aplikujte 0067_case_proposal.sql';
  END IF;
  IF to_regprocedure('public.is_team_member()') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje funkci is_team_member() — nejdřív aplikujte 0002_auth_and_team.sql';
  END IF;
  IF to_regprocedure('public.can_see_sales()') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje funkci can_see_sales() — nejdřív aplikujte 0020_core_sales_crm.sql';
  END IF;
  IF to_regprocedure('public.audit_row_change_soft()') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje funkci audit_row_change_soft() — nejdřív aplikujte 0082_audit_gaps_partner_lockdown.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0091 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mail_content_intake (
  id              bigserial PRIMARY KEY,
  -- Odkud zpráva přišla; dnes jediná hodnota 'outlook_folder' (složka „Cockpit").
  source          text NOT NULL DEFAULT 'outlook_folder',
  -- queued = čeká na ruční přiřazení, proposed = z ní vznikl návrh,
  -- discarded = člověk zahodil, expired = čekala příliš dlouho (retence).
  status          text NOT NULL DEFAULT 'queued',
  -- Proč zpráva čeká (jen u 'queued'): no_match (klient nenalezen), ambiguous
  -- (víc kandidátů), ambiguous_target (klient je jistý, dodávka/obchod ne),
  -- proposal_pending (klient už má čekající návrh stejného druhu),
  -- assign_failed (zápis návrhu selhal, zkusit znovu).
  wait_reason     text,
  -- Klíč idempotence: sha256 Message-ID (opakovaný sync nic nezdvojí).
  dedupe_key      text NOT NULL,
  -- Odkaz na zprávu (Message-ID + webLink z Graphu), 0038. NOT NULL: bez
  -- odkazu na zdroj nic nevznikne (jako case_proposal).
  evidence_id     bigint NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  received_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Jen doména odesílatele (ne adresa); u odchozí zprávy doména příjemce.
  sender_domain   text,
  -- „Obsah": předmět, důkazní úryvek a názvy příloh. Viz retence v hlavičce.
  subject         text,
  excerpt         text,
  attachment_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Rozpoznané příznaky (pravidla bez modelu, případně AI): approval | schedule
  -- | change | attachment. Prázdné = nic rozpoznáno.
  signals         text[] NOT NULL DEFAULT '{}',
  -- Datum z textu (jen když je v úryvku právě jedno); jen NÁVRH k ověření.
  proposed_date   date,
  -- Použil se model (MAIL_CONTENT_AI_ENABLED)? Návrh je pak označený jako návrh AI.
  ai_used         boolean NOT NULL DEFAULT false,
  account_id      bigint REFERENCES account(id) ON DELETE CASCADE,
  engagement_id   bigint REFERENCES engagement(id) ON DELETE SET NULL,
  deal_id         bigint REFERENCES deal(id) ON DELETE SET NULL,
  milestone_id    bigint REFERENCES engagement_milestone(id) ON DELETE SET NULL,
  match_method    text,
  proposal_id     bigint REFERENCES case_proposal(id) ON DELETE SET NULL,
  -- Člen, jehož schránka se čte (OUTLOOK_MAIL_SYNC_MEMBER_ID); NULL = odešel.
  created_by      uuid REFERENCES team_member(id) ON DELETE SET NULL,
  decided_by      text,
  decided_at      timestamptz,
  CONSTRAINT mail_content_intake_source_check CHECK (source ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT mail_content_intake_status_check CHECK (status IN ('queued', 'proposed', 'discarded', 'expired')),
  CONSTRAINT mail_content_intake_wait_check
    CHECK (wait_reason IS NULL OR wait_reason IN ('no_match', 'ambiguous', 'ambiguous_target', 'proposal_pending', 'assign_failed')),
  CONSTRAINT mail_content_intake_dedupe_check CHECK (dedupe_key ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT mail_content_intake_domain_check CHECK (sender_domain IS NULL OR char_length(sender_domain) BETWEEN 1 AND 253),
  CONSTRAINT mail_content_intake_subject_check CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT mail_content_intake_excerpt_check CHECK (excerpt IS NULL OR char_length(excerpt) BETWEEN 1 AND 300),
  CONSTRAINT mail_content_intake_attachments_check
    CHECK (jsonb_typeof(attachment_names) = 'array' AND jsonb_array_length(attachment_names) <= 10),
  CONSTRAINT mail_content_intake_signals_check
    CHECK (signals <@ ARRAY['approval', 'schedule', 'change', 'attachment']::text[]),
  CONSTRAINT mail_content_intake_method_check
    CHECK (match_method IS NULL OR match_method IN ('contact', 'domain', 'alias', 'name', 'manual')),
  -- Obsah drží jen řádek, který ho ještě potřebuje: čekající vždy (úryvek),
  -- zahozený a vypršelý nikdy. Přiřazený (proposed) ho smí mít, dokud
  -- nezasáhne retence.
  CONSTRAINT mail_content_intake_state_consistent CHECK (
    (status = 'queued'
       AND wait_reason IS NOT NULL AND excerpt IS NOT NULL AND proposal_id IS NULL
       AND decided_at IS NULL AND decided_by IS NULL)
    OR (status = 'proposed'
       AND wait_reason IS NULL AND account_id IS NOT NULL
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    OR (status IN ('discarded', 'expired')
       AND wait_reason IS NULL
       AND subject IS NULL AND excerpt IS NULL AND attachment_names = '[]'::jsonb
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT mail_content_intake_dedupe_unique UNIQUE (dedupe_key)
);

-- Fronta „Pošta k zařazení" = čekající, nejstarší nahoře.
CREATE INDEX IF NOT EXISTS mail_content_intake_queued_idx
  ON mail_content_intake (created_at) WHERE status = 'queued';
-- Retence návrhů s úryvkem.
CREATE INDEX IF NOT EXISTS mail_content_intake_proposed_idx
  ON mail_content_intake (created_at) WHERE status = 'proposed';
-- Cizí klíče s ON DELETE (výmaz klienta, dodávky, obchodu, milníku, návrhu,
-- člena a evidence nesmí skenovat tabulku).
CREATE INDEX IF NOT EXISTS mail_content_intake_account_idx
  ON mail_content_intake (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_content_intake_engagement_idx
  ON mail_content_intake (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_content_intake_deal_idx
  ON mail_content_intake (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_content_intake_milestone_idx
  ON mail_content_intake (milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_content_intake_proposal_idx
  ON mail_content_intake (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_content_intake_evidence_idx
  ON mail_content_intake (evidence_id);
CREATE INDEX IF NOT EXISTS mail_content_intake_created_by_idx
  ON mail_content_intake (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE mail_content_intake ENABLE ROW LEVEL SECURITY;

-- Čtení pro tým; žádná INSERT/UPDATE/DELETE politika → klient nezapíše nic.
DROP POLICY IF EXISTS mail_content_intake_read ON mail_content_intake;
CREATE POLICY mail_content_intake_read ON mail_content_intake
  FOR SELECT USING ((SELECT is_team_member()));

-- Obsah pošty klientů = obchodní data: jen obchodní role (jako 0078, 0058).
DROP POLICY IF EXISTS sales_only ON mail_content_intake;
CREATE POLICY sales_only ON mail_content_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT can_see_sales()))
  WITH CHECK ((SELECT can_see_sales()));

DROP POLICY IF EXISTS require_aal2 ON mail_content_intake;
CREATE POLICY require_aal2 ON mail_content_intake
  AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');

REVOKE ALL ON mail_content_intake FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON mail_content_intake FROM authenticated;
GRANT SELECT ON mail_content_intake TO authenticated;
GRANT ALL ON mail_content_intake TO service_role;
GRANT USAGE ON SEQUENCE mail_content_intake_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- Retence obsahu. Volá ji denní cron outlook-mail (service_role), nic jiného.
--   * čekající řádek starší než p_queued_days → vyprší a ztratí text,
--   * řádek s návrhem ztratí text, když o návrhu někdo rozhodl před víc než
--     p_decided_days, návrh zmizel (smazaný), nebo je řádek starší než p_max_days.
-- Řádek samotný zůstává (metadata, dedupe_key brání opětovnému načtení téže
-- zprávy). Vrací počty pro statistiky běhu.

CREATE OR REPLACE FUNCTION purge_mail_content_intake(
  p_queued_days  integer DEFAULT 30,
  p_decided_days integer DEFAULT 30,
  p_max_days     integer DEFAULT 180
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expired integer;
  v_cleared integer;
BEGIN
  IF p_queued_days < 1 OR p_decided_days < 0 OR p_max_days < 1 THEN
    RAISE EXCEPTION 'purge_mail_content_intake: neplatné lhůty' USING ERRCODE = '22023';
  END IF;

  WITH x AS (
    UPDATE mail_content_intake
       SET status = 'expired', wait_reason = NULL,
           subject = NULL, excerpt = NULL, attachment_names = '[]'::jsonb,
           decided_by = 'system:retention', decided_at = now()
     WHERE status = 'queued' AND created_at < now() - make_interval(days => p_queued_days)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_expired FROM x;

  WITH y AS (
    UPDATE mail_content_intake m
       SET subject = NULL, excerpt = NULL, attachment_names = '[]'::jsonb
     WHERE m.status = 'proposed'
       AND (m.subject IS NOT NULL OR m.excerpt IS NOT NULL OR m.attachment_names <> '[]'::jsonb)
       AND (
         m.created_at < now() - make_interval(days => p_max_days)
         OR (m.proposal_id IS NULL AND m.created_at < now() - make_interval(days => p_decided_days))
         OR EXISTS (
           SELECT 1 FROM case_proposal p
            WHERE p.id = m.proposal_id AND p.status <> 'pending'
              AND p.decided_at < now() - make_interval(days => p_decided_days)
         )
       )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_cleared FROM y;

  RETURN jsonb_build_object('expired', v_expired, 'cleared', v_cleared);
END $$;

REVOKE ALL ON FUNCTION purge_mail_content_intake(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_mail_content_intake(integer, integer, integer) TO service_role;

-- Audit (0082, měkký režim): id, stavy, časy, vazby a příznaky s hodnotou;
-- subject, excerpt, attachment_names, sender_domain, proposed_date a dedupe_key
-- jen názvem sloupce. MUSÍ sedět s DB_AUDITED_TABLES.mail_content_intake
-- v core/auditCoverage.ts.
DROP TRIGGER IF EXISTS audit_row_change_soft ON mail_content_intake;
CREATE TRIGGER audit_row_change_soft
  AFTER INSERT OR UPDATE OR DELETE ON mail_content_intake
  FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft(
    'account_id,ai_used,created_by,deal_id,decided_at,decided_by,engagement_id,evidence_id,match_method,milestone_id,proposal_id,received_at,signals,source,status,wait_reason',
    '',
    'evidence_id',
    '');

INSERT INTO schema_migration (version, note)
VALUES ('0091', 'mail_content_intake: vedome vybrana posta s obsahem (slozka Cockpit) - fronta Posta k zarazeni, uryvek max 300 znaku a odkaz misto tela, navrh (case_proposal) potvrzuje vlastnik, jen obchodni role (can_see_sales), retence purge_mail_content_intake, mekky audit')
ON CONFLICT (version) DO NOTHING;
