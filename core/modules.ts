// Přepínače modulů Cockpitu (CompanyConfig.modules). Čistá funkce bez
// hodnot firmy: chybějící `modules` znamená „vše zapnuto".
import type { ModuleKey, ModulesConfig } from './tenant'

export const MODULE_KEYS: readonly ModuleKey[] = [
  'partners', 'deliveries', 'capacity', 'finance', 'targetLists', 'meetings', 'subscriptions', 'agent', 'web', 'shopOrders',
]

/** Je modul u firmy zapnutý? */
export function isModuleOn(modules: ModulesConfig | null | undefined, key: ModuleKey): boolean {
  if (!modules) return true
  return modules[key] === true
}

/** Chyba vrácená API a MCP nástroji vypnutého modulu. */
export const MODULE_OFF_ERROR = 'module_off'
