// Veřejný vstup konektoru Gmail API (Google Workspace firmy). Zbytek kódu
// smí importovat jen odsud (vynucuje ESLint), ne z ./read, ./send ani ./token.
//
// Jeden konektor pro čtení i odesílání:
//   token.ts — přístupový token schránky z GMAIL_REFRESH_TOKENS (společný
//              pro agenta poptávek P2, odchozí frontu P3 i outbound P7),
//   read.ts  — čtení schránek (history.list + záložní polling, P2),
//   send.ts  — odeslání (users.messages.send s threadId, In-Reply-To,
//              References), metadata pro odpověď a dohledání odeslané zprávy (P3).
export * from './token'
export * from './read'
export * from './send'
