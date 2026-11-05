-- 0015 — Podpora importu nabídky z PDF. Sloupec drží cestu k souboru
-- v novém privátním Storage bucketu 'nabidky'; ruční založení projektu
-- (bez importu) ho nechává NULL.
ALTER TABLE deal ADD COLUMN IF NOT EXISTS source_pdf_path text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('nabidky', 'nabidky', false)
ON CONFLICT (id) DO NOTHING;
