// Microsoft Graph (Outlook) je u téhle firmy VYPNUTÝ: pošta běží na Google
// Workspace a agent poptávek čte schránky přes Gmail API (connectors/gmail).
// Zbytek kódu Outlooku (konektor, sync, webhook) zůstává kvůli případnému
// přechodu firmy na Microsoft 365; jeho veřejné vstupy /api/ms/* bez
// MS_GRAPH_ENABLED === 'true' vrací 404 / nic nedělají.
export function msGraphEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MS_GRAPH_ENABLED === 'true'
}
