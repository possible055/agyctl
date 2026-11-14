export const BOOTSTRAP_CHANNEL = 'agyctl:localization:bootstrap';
export const BOOTSTRAP_RESULT_CHANNEL = 'agyctl:localization:bootstrap-result';

// Windows Antigravity 2.31.0 main.js: x5c search state and z7 manager route tree.
const HUB_DOCUMENT_PATHS = new Set([
  '/',
  '/customizations',
  '/customizations/installed',
  '/customizations/browse',
  '/sidecars',
  '/history',
  '/settings',
  '/plugins',
  '/plugins/installed',
  '/plugins/browse',
]);
const HUB_DOCUMENT_PATTERNS = [
  /^\/c\/[^/]+$/,
  /^\/sidecars\/(?:triggers\/)?[^/]+$/,
  /^\/customizations\/(?:plugins|sidecars)\/[^/]+$/,
  /^\/customizations\/marketplaces\/[^/]+\/(?:plugins|skills|bundles)\/[^/]+$/,
  /^\/plugins\/(?:detail\/)?[^/]+$/,
  /^\/view\/[^/]+(?:\/[^/]+)*$/,
  /^\/battle\/[^/]+$/,
  /^\/forked\/[^/]+\/[^/]+$/,
];
const HUB_SEARCH_KEYS = new Set([
  'settingsOpen',
  'settingsScreen',
  'settingsProjectId',
  'settingsSection',
  'feedbackOpen',
  'project',
  'section',
  'login',
  'tab',
  'cascadeId',
  'q',
  'ws',
  'uri',
  'customSubagent',
  'workspaceUri',
  'citcUsername',
  'username',
  'citcAlias',
  'citcId',
  'skipBattleRedirect',
  'path',
  'id',
  'marketplace',
  'source',
  'pluginTab',
  'redirect',
  'focused',
]);

export type HubNavigationMatch =
  | { ok: true; origin: string; hostname: string; port: string; pathname: string }
  | { ok: false; code: 'HUB_URL_INVALID' };

export function matchHubNavigation(targetUrl: string): HubNavigationMatch {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { ok: false, code: 'HUB_URL_INVALID' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'HUB_URL_INVALID' };
  if (url.hostname !== '127.0.0.1') return { ok: false, code: 'HUB_URL_INVALID' };
  if (url.hash !== '') return { ok: false, code: 'HUB_URL_INVALID' };
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
  if (
    !HUB_DOCUMENT_PATHS.has(pathname) &&
    !HUB_DOCUMENT_PATTERNS.some((pattern) => pattern.test(pathname))
  )
    return { ok: false, code: 'HUB_URL_INVALID' };
  try {
    for (const segment of pathname.split('/').slice(1)) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\/\\\x00-\x1f\x7f]/.test(decoded))
        return { ok: false, code: 'HUB_URL_INVALID' };
    }
  } catch {
    return { ok: false, code: 'HUB_URL_INVALID' };
  }
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!HUB_SEARCH_KEYS.has(key) || seen.has(key)) return { ok: false, code: 'HUB_URL_INVALID' };
    seen.add(key);
  }
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'HUB_URL_INVALID' };
  return {
    ok: true,
    origin: url.origin,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
  };
}

export interface BootstrapSenderView {
  senderId: number;
  frameUrl: string | null;
  isMainFrame: boolean;
  hasParentFrame: boolean;
  isCurrentMainFrame: boolean;
  isDestroyed: boolean;
  isGuest: boolean;
}

export type BootstrapAuthorizeResult =
  | { ok: true }
  | { ok: false; code: 'UNAUTHORIZED' | 'DOCUMENT_NOT_READY' | 'DISABLED' };

export function authorizeBootstrapSender(
  sender: BootstrapSenderView,
  expected: { webContentsId: number; origin: string; locale: string },
): BootstrapAuthorizeResult {
  if (expected.locale === 'en') return { ok: false, code: 'DISABLED' };
  if (sender.isDestroyed || sender.senderId !== expected.webContentsId)
    return { ok: false, code: 'UNAUTHORIZED' };
  if (sender.isGuest) return { ok: false, code: 'UNAUTHORIZED' };
  if (!sender.isMainFrame || sender.hasParentFrame || !sender.isCurrentMainFrame)
    return { ok: false, code: 'UNAUTHORIZED' };
  if (!sender.frameUrl || sender.frameUrl === 'about:blank')
    return { ok: false, code: 'DOCUMENT_NOT_READY' };
  const matched = matchHubNavigation(sender.frameUrl);
  if (!matched.ok || matched.origin !== expected.origin) return { ok: false, code: 'UNAUTHORIZED' };
  return { ok: true };
}

export function decodeBootstrapResult(payload: unknown): {
  ok: boolean;
  code?: string;
  stats?: { translated?: number; queued?: number; errors?: number; batches?: number };
} {
  if (typeof payload !== 'object' || payload === null) return { ok: false, code: 'BOOTSTRAP_RESULT_INVALID' };
  const record = payload as Record<string, unknown>;
  const stats =
    record.stats && typeof record.stats === 'object' && !Array.isArray(record.stats)
      ? (record.stats as Record<string, unknown>)
      : null;
  const bounded = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    ok: record.ok === true,
    ...(typeof record.code === 'string' && record.code ? { code: record.code } : {}),
    ...(stats
      ? {
          stats: {
            translated: bounded(stats.translated),
            queued: bounded(stats.queued),
            errors: bounded(stats.errors),
            batches: bounded(stats.batches),
          },
        }
      : {}),
  };
}

export function bootstrapHealthState(result: { ok: boolean; code?: string }): 'active' | 'armed' | 'degraded' {
  if (!result.ok) return 'degraded';
  if (result.code === 'NO_WRITABLE_ROOT') return 'armed';
  return 'active';
}
