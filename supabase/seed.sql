-- Ukázková data pro vývoj a staging (NIKDY na produkci). Všichni zákazníci,
-- kontakty i čísla jsou VYMYŠLENÉ — žádná skutečná firma ani osoba.
-- Spouští se ručně po migracích (fáze obchodu používají klíče z 0049+).
-- Částky v Kč bez DPH.

-- ---- Partneři a dodavatelé ----  (is_referrer = přivádí nám zákazníky)
INSERT INTO partner (id, name, kind, is_referrer) VALUES
  (1, 'Vinařství Ukázka',        'supplier',    false),
  (2, 'Eventová agentura Vzor',  'distributor', true),
  (3, 'Svatební salon Příklad',  'referrer',    true),
  (4, 'Půjčovna inventáře Test', 'supplier',    false);
SELECT setval(pg_get_serial_sequence('partner','id'), 4);

INSERT INTO partner_registration (partner_id, program, status, tier_note) VALUES
  (1, 'dodavatel_napoju',   'registered', 'víno a prosecco na akce'),
  (2, 'eventova_agentura',  'registered', 'firemní akce na klíč'),
  (3, 'svatebni_agentura',  'prospect',   'doporučení svatebních párů'),
  (4, 'pronajem_vybaveni',  'registered', 'stany, mobiliář, nádobí');

-- ---- Zákazníci ----
INSERT INTO account (id, name, industry, size_band, is_reference) VALUES
  (1, 'Firma Alfa s.r.o.',        'IT služby',             'SME',        true),
  (2, 'Beta Konzult a.s.',        'poradenství',           'enterprise', false),
  (3, 'Gama Logistik s.r.o.',     'logistika',             'SME',        false),
  (4, 'Delta Coworking',          'kanceláře a coworking', 'SME',        false),
  (5, 'Jan Novák (soukromá osoba)', NULL,                  NULL,         false),
  (6, 'Petra Svobodová (soukromá osoba)', NULL,            NULL,         false);
SELECT setval(pg_get_serial_sequence('account','id'), 6);

INSERT INTO contact (account_id, full_name, role, email, is_champion) VALUES
  (1, 'Karel Ukázkový',   'office manažer',     'karel@alfa.example',   true),
  (2, 'Lucie Vzorová',    'HR a firemní akce',  'lucie@beta.example',   false),
  (3, 'Tomáš Testovací',  'jednatel',           'tomas@gama.example',   false),
  (4, 'Eva Příkladná',    'provozní',           'eva@delta.example',    false),
  (5, 'Jan Novák',        NULL,                 'jan.novak@email.example', false),
  (6, 'Petra Svobodová',  NULL,                 'petra.svobodova@email.example', false);

-- ---- Obchody ----
INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage, probability_pct,
                  amount_one_time, pillar, phase, note)
VALUES
  (1, 'Vánoční večírek 120 hostů', 'catering_firemni', 'one_time', 'rozsah_nabidka', 55,
   118800, 'b2b_akce', 'nabidka', 'Koktejl a networking, pátek 11. 12., vlastní prostory.'),
  (2, 'Coffee break na konferenci', 'catering_firemni', 'one_time', 'vyhráno', 100,
   25600, 'b2b_akce', 'potvrzeno', 'Dva coffee breaky pro 80 hostů.'),
  (3, 'Firemní BBQ party', 'catering_firemni', 'one_time', 'kvalifikace', 10,
   NULL, 'b2b_akce', 'poptavka', 'Poptávka z webu, upřesnit počet hostů.'),
  (4, 'Pravidelný catering do kanceláře', 'firemni_pravidelny', 'recurring', 'rozsah_nabidka', 55,
   NULL, 'b2b_akce', 'nabidka', 'Grab-and-go boxy třikrát týdně.'),
  (5, 'Svatební hostina 60 hostů', 'svatebni_hostina', 'one_time', 'rozsah_nabidka', 55,
   113400, 'b2c_oslavy', 'nabidka', 'Sobota v červnu, zahrada, vegetariánská varianta pro 8 hostů.'),
  (6, 'Narozeninová oslava + cheesecake dort', 'oslava_soukroma', 'one_time', 'vyhráno', 100,
   24990, 'b2c_oslavy', 'realizovano', 'Raut pro 30 hostů a dort Daddy pistáciovo-malinový.');

UPDATE deal SET won_at = '2026-10-20' WHERE stage = 'vyhráno' AND won_at IS NULL;

-- ---- Ukázková poptávka z webu a objednávka cheesecaku (0102) ----
INSERT INTO web_inquiry (client_token, segment, event_type, event_date, guests, customer_name, email,
                         company_name, source_page, inquiry)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'b2b', 'firemni_party', '2027-05-21', 70, 'Tomáš Testovací',
   'tomas@gama.example', 'Gama Logistik s.r.o.', '/catering/firemni-akce',
   '{"segment":"b2b","event_type":"firemni_party","package_key":null,"event_date":"2027-05-21","start_time":"16:00","duration_hours":5,"guests":70,"venue":"Praha 10","extras":[],"dietary":[],"special_requests":null}');

INSERT INTO shop_order (client_token, fulfilment_date, fulfilment, customer_name, email, phone,
                        items, total_czk)
VALUES
  ('00000000-0000-4000-8000-000000000002', '2026-12-20', 'pickup', 'Petra Svobodová',
   'petra.svobodova@email.example', '+420 600 000 000',
   '[{"product_key":"mini_mix","label":"Mini cheesecaky mix","quantity":2,"unit_price_czk":575,"total_czk":1150}]',
   1150);
