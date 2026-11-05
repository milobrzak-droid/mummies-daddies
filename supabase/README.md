# Supabase — schéma a ukázková data

- `migrations/` — číslované migrace (souvislá řada; zástupci 0103–0106 jsou
  rezervovaná čísla paralelních balíků). Aplikuje je `scripts/migrate.mjs`
  (postup v `docs/PROVOZ.md`, oddíl 1). Hodnoty firmy (uzly, pilíře, týmy,
  obchodní linky, šablony realizace) jsou psané přímo v migracích a musí
  sedět s `config/mummiesDaddies.ts` — hlídají to testy.
- `seed.sql` — vymyšlení zákazníci a obchody pro vývoj a staging. Nikdy na
  produkci.
- `certs/` — kořenové certifikáty pro ověření TLS při migracích.

Po migracích: první uživatel v Authentication, správce a vlastníci uzlů
podle `docs/PROVOZ.md`, oddíl 1b.
