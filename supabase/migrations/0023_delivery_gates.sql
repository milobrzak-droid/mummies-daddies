-- 0023 — Kvalitativní brány dodávky.
--
-- Zdroj: ENTER DELIVERY STANDARD (EDS) v1.1, §13 Quality gates. Dodávka
-- projde jen tehdy, když platí všech šest — jinak podle vaší vlastní
-- definice „to není hotové předání". Doteď to nešlo nikde zaznamenat, takže se
-- kvalita dodávky nedala doložit ani zpětně dohledat.
--
-- Pozn.: EDS je vedený jako „In Review" a leží v Archivu. §12.1 ale řadí
-- kvalitativní brány mezi stabilní části metodiky, proto je bereme jako
-- platné. Kdyby se standard změnil, jsou to jen sloupce.
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_outputs_captured boolean;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_ratios_respected boolean;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_peer_learning boolean;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_safety_followed boolean;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_next_steps_owned boolean;
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS gate_pack_delivered boolean;

-- Kde deliverable pack leží (EDS §9.2 — každá dodávka ho musí vyprodukovat
-- a uložit na dohodnuté místo).
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS deliverable_pack_url text;

-- Kontrolní schůzka po dodávce (EDS §11.2 — follow-up checkpoint patří
-- ke standardu toho, co klient dostane).
ALTER TABLE engagement ADD COLUMN IF NOT EXISTS follow_up_checkpoint_on date;

-- Záměrně NEpočítáme „prošlo" v databázi: nevyplněná brána a brána
-- vyhodnocená jako nesplněná jsou dvě různé věci a spočítaný boolean by
-- ten rozdíl zahodil. NULL = ještě nikdo nehodnotil.
COMMENT ON COLUMN engagement.gate_outputs_captured IS 'EDS §13: výstupy v odsouhlasených šablonách. NULL = nehodnoceno.';
