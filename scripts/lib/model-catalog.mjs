import fs from 'node:fs';
import { splitModelIdentity } from '../../src/plugin/lib/model-label.mjs';
import {
  callLanguageServer,
  discoverLanguageServer,
} from '../../src/plugin/sidecars/panel/transport.mjs';
import { inspectHostTarget } from './client-target.mjs';
import { loadCapsuleServedBundle } from './host-build.mjs';
import { findAsarPath } from './install-paths.mjs';

export function readModelEnum(source) {
  const candidates = [];
  for (const match of source.matchAll(/\bModel\s*=\s*\{([^{}]{1,100000})\}/g)) {
    const entries = match[1]
      .split(',')
      .map((entry) => /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d+(?:[eE]\d+)?)\s*$/.exec(entry));
    if (entries.some((entry) => !entry)) continue;
    const values = new Map(entries.map((entry) => [`MODEL_${entry[1]}`, Number(entry[2])]));
    if (values.get('MODEL_UNSPECIFIED') !== 0) continue;
    if (
      values.size !== entries.length ||
      [...values.values()].some((id) => !Number.isInteger(id) || id < 0 || id > 2147483647)
    )
      throw new Error('Invalid model enum');
    candidates.push(values);
  }
  if (candidates.length !== 1) throw new Error('The installed model enum cannot be identified');
  return candidates[0];
}

export function normalizeModelCatalog(raw, modelEnum) {
  const profiles = raw?.response?.models;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles))
    throw new Error('Invalid available-model response');
  const groups = raw.response.agentModelSorts?.[0]?.groups;
  if (
    !Array.isArray(groups) ||
    groups.some(
      (group) =>
        !Array.isArray(group?.modelIds) ||
        group.modelIds.some((alias) => typeof alias !== 'string' || !alias.trim()),
    )
  )
    throw new Error('Invalid available-model sort');
  const models = [];
  for (const alias of new Set(groups.flatMap((group) => group.modelIds))) {
    if (!Object.hasOwn(profiles, alias)) continue;
    const profile = profiles[alias];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile))
      throw new Error('Invalid model profile');
    if (profile.displayName === undefined) continue;
    if (
      typeof profile.displayName !== 'string' ||
      !profile.displayName.trim() ||
      profile.displayName.length > 256 ||
      [...profile.displayName].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      (profile.disabled !== undefined && typeof profile.disabled !== 'boolean')
    )
      throw new Error('Invalid model display name or availability');
    const id = modelEnum.get(profile.model);
    const { base, effort } = splitModelIdentity(alias, profile.displayName);
    models.push({
      alias,
      name: profile.displayName,
      baseName: base,
      effort,
      id: id > 0 ? id : null,
      available: profile.disabled !== true,
    });
  }
  return { status: 'available', models, error: null };
}

const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_CACHE_LIMIT = 32;
const catalogCache = new Map();

function catalogCacheKey(binary) {
  const stat = fs.statSync(binary);
  // The limit patcher preserves size and mtime on atomic replace, so the
  // replacement-identity fields must join the key as in sha256FileCached.
  return `${binary}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.birthtimeMs}|${stat.ino}`;
}

export async function readModelCatalog(binaryPath) {
  try {
    const binary = binaryPath ?? inspectHostTarget(findAsarPath()).binaryPath;
    const key = catalogCacheKey(binary);
    const cached = catalogCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.catalog;
    catalogCache.delete(key);
    const scripts = loadCapsuleServedBundle().readServedScripts(binary);
    const modelEnum = readModelEnum(scripts['main.js']);
    const signal = AbortSignal.timeout(10000);
    const endpoint = await discoverLanguageServer(false, null, signal);
    const raw = await callLanguageServer(
      endpoint,
      'GetAvailableModels',
      { forceRefresh: false },
      { signal },
    );
    const catalog = normalizeModelCatalog(raw, modelEnum);
    catalogCache.set(key, { fetchedAt: Date.now(), catalog });
    if (catalogCache.size > CATALOG_CACHE_LIMIT)
      catalogCache.delete(catalogCache.keys().next().value);
    return catalog;
  } catch (error) {
    console.error('[agyctl] Model catalog:', error.message);
    return { status: 'unavailable', models: [], error: 'MODEL_CATALOG_UNAVAILABLE' };
  }
}
