-- 0099 — mail_content_intake: návrh zakázky z PDF nabídky v příloze e-mailu
-- (MAIL_OFFER_ATTACHMENT_ENABLED, docs/PROVOZ.md).
--
-- PROČ: nová zakázka včetně ceny má do Cockpitu vstoupit z e-mailu bez ruční práce.
-- Zpráva ve složce „Cockpit" (0091), která má PDF přílohu podobnou nabídce, se přes
-- Graph stáhne, přečte stejným krokem jako ruční import nabídky (PDF → návrh AI:
-- klient, název, cena, měna, rozsah) a výsledek čeká ve frontě „Pošta k zařazení"
-- jako NÁVRH ZAKÁZKY. Klienta a obchod založí až potvrzení člověka
-- (confirmOfferProposal), nic se nezaloží samo.
--
-- CO SE UKLÁDÁ (minimalizace)
--   * PDF SE NEUKLÁDÁ. Čte se v paměti jednoho běhu a zahodí se. Ani do storage.
--   * offer_draft = jen NÁVRH AI z PDF (klient, název, částka, měna, fáze, varování;
--     tvar StoredOfferProposal z offerProposal.ts) jako jsonb ≤ 16 kB. Je to
--     obchodní údaj stejného druhu jako úryvek: RLS a retence jako zbytek řádku.
--     Drží ho JEN čekající řádek (CHECK): po potvrzení, zahození i po vypršení
--     (30 dní) je NULL. Po potvrzení žije jen v obchodu.
--   * offer_proposal_id = id návrhu odvozené z (Message-ID, id přílohy): stejná
--     příloha téže zprávy dá vždy totéž id → unikátní index = idempotence, a obchod
--     z něj dostane deterministický deal.source_pdf_path (0070).
--   * offer_pdf_sha256 = otisk PDF (ne obsah): stejná nabídka přeposlaná sobě jako
--     druhá zpráva nevytvoří druhý návrh.
--
-- OPRÁVNĚNÍ A AUDIT: beze změny oproti 0091 (RLS sales_only + AAL2, zapisuje jen
-- server). Měkký audit trigger se nemění: nové sloupce nejsou v allow-listu, takže
-- se do auditu dostanou jen názvem, nikdy hodnotou.
--
-- Nový důvod čekání wait_reason = 'offer_draft'. CHECK offer_check drží, že
-- offer_draft je vyplněn právě u čekajícího řádku s tímto důvodem.
-- purge_mail_content_intake() při vypršení řádku smaže i offer_draft.
--
-- IDEMPOTENCE: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, CREATE
-- INDEX IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT. Zámky: sloupce bez výchozí
-- hodnoty jsou metadata; CHECKy a index nad malou tabulkou.
--
-- ZÁVISLOSTI: 0091 (mail_content_intake, purge_mail_content_intake), 0026 (ledger).
-- Guard níže skončí srozumitelnou chybou.

DO $$
BEGIN
  IF to_regclass('public.mail_content_intake') IS NULL THEN
    RAISE EXCEPTION '0099 vyžaduje tabulku mail_content_intake — nejdřív aplikujte 0091_mail_content_intake.sql';
  END IF;
  IF to_regprocedure('public.purge_mail_content_intake(integer, integer, integer)') IS NULL THEN
    RAISE EXCEPTION '0099 vyžaduje funkci purge_mail_content_intake — nejdřív aplikujte 0091_mail_content_intake.sql';
  END IF;
  IF to_regclass('public.schema_migration') IS NULL THEN
    RAISE EXCEPTION '0099 vyžaduje ledger schema_migration — nejdřív aplikujte 0026_migration_ledger.sql';
  END IF;
END $$;

ALTER TABLE mail_content_intake
  ADD COLUMN IF NOT EXISTS offer_proposal_id uuid,
  ADD COLUMN IF NOT EXISTS offer_draft jsonb,
  ADD COLUMN IF NOT EXISTS offer_pdf_sha256 text;

-- Nový důvod čekání: návrh zakázky z nabídky v příloze.
ALTER TABLE mail_content_intake DROP CONSTRAINT IF EXISTS mail_content_intake_wait_check;
ALTER TABLE mail_content_intake ADD CONSTRAINT mail_content_intake_wait_check
  CHECK (wait_reason IS NULL OR wait_reason IN ('no_match', 'ambiguous', 'ambiguous_target', 'proposal_pending', 'assign_failed', 'offer_draft'));

-- Návrh zakázky drží jen čekající řádek s důvodem offer_draft; otisk PDF je hash.
ALTER TABLE mail_content_intake DROP CONSTRAINT IF EXISTS mail_content_intake_offer_check;
ALTER TABLE mail_content_intake ADD CONSTRAINT mail_content_intake_offer_check CHECK (
  (wait_reason IS NOT DISTINCT FROM 'offer_draft') = (offer_draft IS NOT NULL)
  AND (offer_draft IS NULL
       OR (offer_proposal_id IS NOT NULL
           AND jsonb_typeof(offer_draft) = 'object'
           AND octet_length(offer_draft::text) <= 16384))
  AND (offer_pdf_sha256 IS NULL OR offer_pdf_sha256 ~ '^[0-9a-f]{64}$')
);

-- Idempotence: jedna příloha jedné zprávy = jeden návrh.
CREATE UNIQUE INDEX IF NOT EXISTS mail_content_intake_offer_proposal_uniq
  ON mail_content_intake (offer_proposal_id) WHERE offer_proposal_id IS NOT NULL;
-- Stejné PDF podruhé (přeposlaná nabídka): hledání otisku.
CREATE INDEX IF NOT EXISTS mail_content_intake_offer_sha_idx
  ON mail_content_intake (offer_pdf_sha256) WHERE offer_pdf_sha256 IS NOT NULL;

-- Retence: jako v 0091, a při vypršení čekajícího řádku zmizí i návrh zakázky
-- (jinak by řádek s NULL důvodem čekání porušil CHECK offer_check).
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
           subject = NULL, excerpt = NULL, attachment_names = '[]'::jsonb, offer_draft = NULL,
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

INSERT INTO schema_migration (version, note)
VALUES ('0099', 'mail_content_intake: navrh zakazky z PDF nabidky v priloze e-mailu (offer_draft, offer_proposal_id, offer_pdf_sha256, wait_reason offer_draft), PDF se neuklada, navrh jen u cekajiciho radku, retence maze i navrh')
ON CONFLICT (version) DO NOTHING;
