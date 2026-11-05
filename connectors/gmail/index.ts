// Veřejný vstup konektoru Gmail API (Google Workspace firmy). Zbytek kódu
// smí importovat jen odsud (vynucuje ESLint), ne z ./read ani ./token.
//
// P2 (agent příchozích poptávek): čtení schránek (history.list + záložní
// polling, metadata a text zprávy jen v paměti). Odeslání
// (users.messages.send s threadId, In-Reply-To a References) patří odchozí
// frontě (P3) a přidává se sem jako další soubor.
export * from './token'
export * from './read'
