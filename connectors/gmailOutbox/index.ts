// Veřejný vstup konektoru Gmail pro odchozí frontu agenta (balík P3):
// odeslání zprávy (users.messages.send), metadata původní zprávy a vlákna,
// dohledání odeslané zprávy podle Message-ID a obnova tokenu Google OAuth.
// Zbytek kódu smí importovat jen odsud (vynucuje ESLint).
export * from './send'
export * from './token'
