// Worker — plánovač a dlouhé úlohy (kapitola 9 plánu přestavby).
//
// Worker smí volat core/, domain/ i connectors/; opačným směrem se na něj
// nikdo nesmí odkazovat (viz docs/PROVOZ.md a eslint.config.mjs).
// Základ: runJob (zámek proti překryvu, migrace 0040), pražský čas, registr.
export * from './jobRunner'
export * from './pragueTime'
export * from './registry'
export * from './followUpWatch'
export * from './approvalExpiry'
