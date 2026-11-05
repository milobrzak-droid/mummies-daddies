-- 0030 — Karta firmy a stav vztahu odvozený z korespondence.
--
-- Dvě věci najednou, protože jsou to dvě strany téhož:
--
-- 1) ČÍM TA FIRMA JE. Obor v CRM byl od začátku, ale vyplněný u 11 z 37.
--    Pokus doplnit ho automaticky z NACE selhal a nedá se zachránit: ARES
--    vrací kódy seřazené podle ČÍSLA, ne podle důležitosti, takže první kód
--    je náhoda. Globusu by tím vyšlo „Stavebnictví" (4120 je nižší než
--    47110 = hypermarket), Spolchemii „Doprava a skladování" (52100 místo
--    chemie), Servisu Climax „silniční nákladní doprava". ARES navíc hlavní
--    činnost nikde neoznačuje. Kódy proto ukládáme jako fakt k nahlédnutí
--    a obor zůstává na člověku nebo na tom, co o firmě reálně víme.
--
-- 2) JAK S NÁMI TA FIRMA STOJÍ. Odvozeno z toho, kdo psal naposledy.
--    Rozdíl mezi „my jsme psali poslední" a „oni psali poslední" je celý
--    smysl: v prvním případě nás ignorují a je na místě připomenout se,
--    ve druhém dlužíme odpověď my — a to je ten případ, který tiše
--    prohrává obchody a běžné CRM ho nezachytí.

-- Fakta z rejstříku (žádná interpretace)
ALTER TABLE account ADD COLUMN IF NOT EXISTS nace text[];
ALTER TABLE account ADD COLUMN IF NOT EXISTS legal_form text;
ALTER TABLE account ADD COLUMN IF NOT EXISTS founded_on date;

-- Čím firma je vlastními slovy: jedna věta, co dělá a jak je velká.
-- Z rejstříku se vyčíst nedá, ale z korespondence a schůzek ano.
ALTER TABLE account ADD COLUMN IF NOT EXISTS profile text;

-- Stav vztahu. Ukládá se jen to, co je fakt (kdy kdo psal); „kdo je na
-- tahu" se z toho počítá až při zobrazení, aby nemohlo zastarat.
ALTER TABLE account ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
ALTER TABLE account ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;

-- Kdy se naposledy řešilo, že je ticho — ať připomínka nechodí denně.
ALTER TABLE account ADD COLUMN IF NOT EXISTS nudged_on date;

-- Vyřazení z připomínek: firma, která řekla ne, nebo se řeší jinde.
ALTER TABLE account ADD COLUMN IF NOT EXISTS snooze_until date;

CREATE INDEX IF NOT EXISTS account_contact_recency_idx
  ON account(last_outbound_at DESC NULLS LAST, last_inbound_at DESC NULLS LAST);
