import { parseDuration } from '../../lib/metrics-core.mjs';

// Language Server transport (discovery + Connect-RPC) lives in transport.mjs;
// this re-export keeps the panel-internal import surface (usage.mjs) unchanged.
export { callLanguageServer, discoverLanguageServer } from './transport.mjs';

/**
 * 解析 seconds 字串並四捨五入到 2 位 (例如 "4.056162s" -> 4.06)
 */
/** @param {unknown} secStr */
export function parseSeconds(secStr) {
  const val = parseDuration(secStr);
  return val === null ? null : Number(val.toFixed(2));
}
