# Kořenový certifikát Supabase

Sem patří veřejný kořenový certifikát Supabase (`prod-ca-2021.crt`, přípona
`.crt`). Migrační běhač (`scripts/migrate.mjs`) proti němu ověřuje
certifikát databáze včetně jména hostu — bez ověření by se mezi běhač
(role vlastníka databáze, DDL) a databázi mohl vložit kdokoliv na cestě.

Stažení: Supabase → projekt → Project Settings → Database → SSL
Configuration → Download certificate. Není to tajemství, patří do repa.
Postup: `docs/PROVOZ.md`, oddíl 1a.
