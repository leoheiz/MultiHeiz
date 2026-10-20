'use strict';

/**
 * Catálogo de apps prontos (MultiHeiz 1.3.0).
 * JSON em src/main/catalog/apps.json; ícones SVG locais (não oficiais).
 *
 * Validação ao carregar: URL só https (url-policy); entradas inválidas
 * são ignoradas com log. Ícone do catálogo fica no estado (catalogIcon)
 * e é usado na barra lateral até page-favicon-updated (favicon da página
 * tem prioridade quando chegar).
 *
 * tweaks.userAgent: o UA Chrome já é global; o campo só documenta intenção
 * e não altera comportamento por janela (mecanismo por janela inexistente).
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isNavigableUrl } = require('./url-policy');

const CATALOG_DIR = path.join(__dirname, 'catalog');
const APPS_JSON = path.join(CATALOG_DIR, 'apps.json');

/** @type {CatalogApp[]|null} */
let cachedApps = null;

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   url: string,
 *   defaultName: string,
 *   icon: string,
 *   color: string,
 *   keywords: string[],
 *   tweaks?: object,
 *   iconPath: string,
 *   iconUrl: string,
 * }} CatalogApp
 */

/**
 * @param {unknown} raw
 * @returns {CatalogApp|null}
 */
function validateEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const url = String(raw.url || '').trim();
  const defaultName = String(raw.defaultName || name || '').trim();
  const icon = String(raw.icon || '').trim().replace(/\\/g, '/');
  const color = String(raw.color || '#2bb8a6').trim();
  if (!id || !name || !url || !defaultName || !icon) {
    console.warn('[catalog] entrada incompleta ignorada:', raw && raw.id);
    return null;
  }
  if (!/^https:/i.test(url) || !isNavigableUrl(url)) {
    console.warn('[catalog] URL inválida (só https):', id, url);
    return null;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      console.warn('[catalog] protocolo não-https ignorado:', id, url);
      return null;
    }
  } catch {
    console.warn('[catalog] URL malformada ignorada:', id, url);
    return null;
  }
  // Ícone só dentro de catalog/ (sem path traversal)
  if (icon.includes('..') || path.isAbsolute(icon) || /^[a-zA-Z]:/.test(icon)) {
    console.warn('[catalog] ícone inválido ignorado:', id, icon);
    return null;
  }
  const iconPath = path.join(CATALOG_DIR, ...icon.split('/'));
  if (!iconPath.startsWith(CATALOG_DIR) || !fs.existsSync(iconPath)) {
    console.warn('[catalog] arquivo de ícone ausente:', id, iconPath);
    return null;
  }
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  const tweaks =
    raw.tweaks && typeof raw.tweaks === 'object' && !Array.isArray(raw.tweaks)
      ? { ...raw.tweaks }
      : undefined;
  return {
    id,
    name,
    url,
    defaultName,
    icon,
    color,
    keywords,
    tweaks,
    iconPath,
    iconUrl: pathToFileURL(iconPath).href,
  };
}

/**
 * Carrega e valida o catálogo (cache em memória).
 * @returns {CatalogApp[]}
 */
function loadCatalog() {
  if (cachedApps) return cachedApps;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(APPS_JSON, 'utf8'));
  } catch (err) {
    console.warn('[catalog] falha ao ler apps.json:', err && err.message ? err.message : err);
    cachedApps = [];
    return cachedApps;
  }
  if (!Array.isArray(raw)) {
    console.warn('[catalog] apps.json não é array');
    cachedApps = [];
    return cachedApps;
  }
  /** @type {CatalogApp[]} */
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const app = validateEntry(entry);
    if (!app) continue;
    if (seen.has(app.id)) {
      console.warn('[catalog] id duplicado ignorado:', app.id);
      continue;
    }
    seen.add(app.id);
    out.push(app);
  }
  cachedApps = out;
  return cachedApps;
}

/** Limpa cache (selftests / hot-reload). */
function clearCatalogCache() {
  cachedApps = null;
}

/**
 * Lista pública para o renderer (sem iconPath absoluto se preferir só iconUrl).
 * @returns {Array<object>}
 */
function listAppsPublic() {
  return loadCatalog().map((a) => ({
    id: a.id,
    name: a.name,
    url: a.url,
    defaultName: a.defaultName,
    icon: a.icon,
    iconUrl: a.iconUrl,
    color: a.color,
    keywords: a.keywords.slice(),
    tweaks: a.tweaks ? { ...a.tweaks } : undefined,
  }));
}

/**
 * @param {string} id
 * @returns {CatalogApp|null}
 */
function getAppById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return loadCatalog().find((a) => a.id === key) || null;
}

/**
 * Resolve file:// URL do ícone persistido (caminho relativo ao catálogo).
 * @param {string} iconRel
 * @returns {string}
 */
function iconFileUrl(iconRel) {
  const rel = String(iconRel || '').trim().replace(/\\/g, '/');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return '';
  const iconPath = path.join(CATALOG_DIR, ...rel.split('/'));
  if (!iconPath.startsWith(CATALOG_DIR) || !fs.existsSync(iconPath)) return '';
  return pathToFileURL(iconPath).href;
}

/**
 * Nome único na área de trabalho: "WhatsApp", "WhatsApp 2", "WhatsApp 3"…
 * @param {string} desired
 * @param {Array<{name?: string, workspaceId?: string}>} accounts
 * @param {string} workspaceId
 * @returns {string}
 */
function uniqueNameInWorkspace(desired, accounts, workspaceId) {
  const base = String(desired || '').trim() || 'Janela';
  const names = new Set(
    (accounts || [])
      .filter((a) => a && a.workspaceId === workspaceId)
      .map((a) => String(a.name || ''))
  );
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(base + ' ' + n)) n += 1;
  return base + ' ' + n;
}

/**
 * Filtro de busca (nome + keywords). Puro / testável.
 * @param {Array<{name?: string, keywords?: string[]}>} apps
 * @param {string} query
 * @returns {typeof apps}
 */
function filterApps(apps, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return apps.slice();
  return (apps || []).filter((a) => {
    const name = String(a.name || '').toLowerCase();
    if (name.includes(q)) return true;
    const kws = Array.isArray(a.keywords) ? a.keywords : [];
    for (const k of kws) {
      const kw = String(k || '').toLowerCase();
      if (!kw) continue;
      // keyword contém a busca (ex.: "zap", "twitter"); não o inverso
      // (evita "tt" ∈ "twitter" → falso positivo TikTok).
      if (kw === q || kw.includes(q) || kw.startsWith(q)) return true;
    }
    return false;
  });
}

/**
 * Enriquecer conta pública com iconUrl do catálogo.
 * @param {object} account
 * @returns {object}
 */
function enrichAccountPublic(account) {
  if (!account || typeof account !== 'object') return account;
  const rel = account.catalogIcon;
  if (!rel) return account;
  const url = iconFileUrl(rel);
  if (!url) return account;
  return { ...account, catalogIconUrl: url };
}

module.exports = {
  CATALOG_DIR,
  APPS_JSON,
  loadCatalog,
  clearCatalogCache,
  listAppsPublic,
  getAppById,
  iconFileUrl,
  uniqueNameInWorkspace,
  filterApps,
  enrichAccountPublic,
  validateEntry,
};
