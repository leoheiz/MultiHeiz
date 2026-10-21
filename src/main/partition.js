'use strict';

/**
 * Sessões Chromium: `persist:acc-<partitionId>`.
 * Por padrão partitionId === account.id (uma sessão por janela).
 * Janelas que compartilham a mesma sessão reutilizam o mesmo partitionId
 * (ex.: "Abrir nova janela com a mesma sessão", área "Navegador convencional").
 */

/**
 * @param {{ id?: string, partitionId?: string }|null|undefined} account
 * @returns {string}
 */
function resolvePartitionId(account) {
  if (!account || typeof account !== 'object') return '';
  const explicit = account.partitionId != null ? String(account.partitionId).trim() : '';
  if (explicit) return explicit;
  return account.id != null ? String(account.id) : '';
}

/**
 * @param {string} partitionId
 * @returns {string}
 */
function partitionString(partitionId) {
  const id = String(partitionId || '').trim();
  return id ? `persist:acc-${id}` : 'persist:acc-unknown';
}

/**
 * @param {{ id?: string, partitionId?: string }|null|undefined} account
 * @returns {string}
 */
function partitionForAccount(account) {
  return partitionString(resolvePartitionId(account));
}

/**
 * Conta quantas janelas (em qualquer área) usam a partição.
 * @param {string} partitionId
 * @param {Array<{ id?: string, partitionId?: string }>|null|undefined} accounts
 * @param {{ excludeAccountId?: string }} [opts]
 * @returns {number}
 */
function countPartitionUsers(partitionId, accounts, opts = {}) {
  const key = String(partitionId || '').trim();
  if (!key) return 0;
  const exclude = opts.excludeAccountId != null ? String(opts.excludeAccountId) : '';
  let n = 0;
  for (const a of accounts || []) {
    if (!a || !a.id) continue;
    if (exclude && a.id === exclude) continue;
    if (resolvePartitionId(a) === key) n += 1;
  }
  return n;
}

/**
 * Mapa partitionId → quantidade de janelas.
 * @param {Array<{ id?: string, partitionId?: string }>|null|undefined} accounts
 * @returns {Map<string, number>}
 */
function partitionUsageMap(accounts) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const a of accounts || []) {
    if (!a || !a.id) continue;
    const pid = resolvePartitionId(a);
    if (!pid) continue;
    map.set(pid, (map.get(pid) || 0) + 1);
  }
  return map;
}

/**
 * Enriquece contas públicas com partitionId resolvido e sessionShareCount.
 * @param {Array<object>} accounts
 * @returns {Array<object>}
 */
function enrichAccountsSessionShare(accounts) {
  const usage = partitionUsageMap(accounts);
  return (accounts || []).map((a) => {
    if (!a || typeof a !== 'object') return a;
    const partitionId = resolvePartitionId(a);
    const sessionShareCount = usage.get(partitionId) || 1;
    return { ...a, partitionId, sessionShareCount };
  });
}

module.exports = {
  resolvePartitionId,
  partitionString,
  partitionForAccount,
  countPartitionUsers,
  partitionUsageMap,
  enrichAccountsSessionShare,
};
