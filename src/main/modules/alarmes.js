'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, Notification } = require('electron');
const { createJsonStore } = require('../json-store');

const PRIORITY_RANK = { alta: 0, normal: 1, baixa: 2 };

function defaultAlarmes() {
  return {
    version: 1,
    reminders: [],
    timers: [],
    lastRunAt: Date.now(),
  };
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let store = null;
/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();
/** @type {((payload: object) => void) | null} */
let emitFn = null;
/** @type {Array<object>} */
let testNotificationLog = [];

function getStore() {
  if (!store) store = createJsonStore(path.join('modules', 'alarmes.json'), defaultAlarmes, 400);
  return store;
}

function ensureDir() {
  fs.mkdirSync(path.join(app.getPath('userData'), 'modules'), { recursive: true });
}

function init(emit) {
  emitFn = emit;
  ensureDir();
  getStore().load();
  rescheduleAll();
}

function emit(payload) {
  if (emitFn) emitFn(payload);
}

function normalizePriority(p) {
  const v = String(p || 'normal').toLowerCase();
  if (v === 'alta' || v === 'baixa') return v;
  return 'normal';
}

function list() {
  const d = getStore().get();
  return {
    reminders: [...(d.reminders || [])],
    timers: [...(d.timers || [])],
  };
}

function clearTimer(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(t) {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function effectiveNextAt(reminder, now) {
  const n = now || Date.now();
  if (reminder && reminder.snoozeUntil && Number(reminder.snoozeUntil) > n) {
    return Number(reminder.snoozeUntil);
  }
  return reminder && (reminder.nextAt || reminder.at) != null
    ? Number(reminder.nextAt || reminder.at)
    : null;
}

function isCompleted(reminder) {
  if (!reminder) return false;
  if (reminder.completedAt) return true;
  if (reminder.kind === 'one-off' && reminder.enabled === false) return true;
  return false;
}

function isActive(reminder) {
  return !!reminder && reminder.enabled !== false && !isCompleted(reminder);
}

/**
 * Filter reminders into views: hoje | proximos | recorrentes | concluidos
 */
function filterByView(reminders, view, now) {
  const n = now != null ? now : Date.now();
  const sod = startOfDay(n);
  const eod = endOfDay(n);
  const listIn = Array.isArray(reminders) ? reminders : [];
  switch (view) {
    case 'hoje':
      return listIn.filter((r) => {
        if (!isActive(r)) return false;
        const next = effectiveNextAt(r, n);
        return next != null && next >= sod && next <= eod;
      });
    case 'proximos':
      return listIn.filter((r) => {
        if (!isActive(r)) return false;
        const next = effectiveNextAt(r, n);
        return next != null && next > eod;
      });
    case 'recorrentes':
      return listIn.filter((r) => isActive(r) && r.kind === 'recurring');
    case 'concluidos':
      return listIn.filter((r) => isCompleted(r));
    default:
      return listIn.filter((r) => isActive(r));
  }
}

function sortByPriorityThenNext(reminders, now) {
  const n = now != null ? now : Date.now();
  return [...(reminders || [])].sort((a, b) => {
    const pa = PRIORITY_RANK[normalizePriority(a.priority)] ?? 1;
    const pb = PRIORITY_RANK[normalizePriority(b.priority)] ?? 1;
    if (pa !== pb) return pa - pb;
    const na = effectiveNextAt(a, n) || 0;
    const nb = effectiveNextAt(b, n) || 0;
    return na - nb;
  });
}

function nextOccurrence(reminder, fromTime) {
  const from = fromTime || Date.now();
  if (!reminder || reminder.enabled === false) return null;
  if (reminder.kind === 'one-off') {
    const at = Number(reminder.at) || 0;
    return at > from ? at : null;
  }
  if (reminder.kind === 'recurring') {
    if (reminder.recur === 'daily') {
      const [hh, mm] = String(reminder.timeOfDay || '09:00').split(':').map(Number);
      const d = new Date(from);
      d.setSeconds(0, 0);
      d.setHours(hh || 0, mm || 0, 0, 0);
      if (d.getTime() <= from) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (reminder.recur === 'weekly') {
      const days = Array.isArray(reminder.weekdays) ? reminder.weekdays.map(Number) : [1];
      const [hh, mm] = String(reminder.timeOfDay || '09:00').split(':').map(Number);
      for (let i = 0; i < 8; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        d.setHours(hh || 0, mm || 0, 0, 0);
        const dow = d.getDay(); // 0=Sun
        if (days.includes(dow) && d.getTime() > from) return d.getTime();
      }
      return null;
    }
    if (reminder.recur === 'interval') {
      const everyMs =
        (Number(reminder.intervalMinutes) || 0) * 60 * 1000 ||
        (Number(reminder.intervalHours) || 0) * 60 * 60 * 1000 ||
        60 * 60 * 1000;
      // Prefer original schedule base (`at`), never a temporary snooze nextAt
      const base = Number(reminder.at) || Number(reminder.scheduleBase) || from;
      if (base > from) return base;
      const steps = Math.floor((from - base) / everyMs) + 1;
      return base + steps * everyMs;
    }
  }
  return null;
}

function fireReminder(reminder) {
  const title = reminder.title || 'Lembrete';
  const body = reminder.body || '';
  testNotificationLog.push({
    id: reminder.id,
    title,
    body,
    at: Date.now(),
    windowId: reminder.windowId || null,
  });
  emit({
    type: 'alarmes:fired',
    reminder: { ...reminder },
  });

  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `MultiHeiz — ${title}`,
        body: body || 'Toque para abrir',
        silent: false,
      });
      n.on('click', () => {
        emit({
          type: 'alarmes:notification-click',
          reminderId: reminder.id,
          windowId: reminder.windowId || null,
        });
      });
      n.show();
    }
  } catch (err) {
    console.warn('[alarmes] notification failed', err && err.message);
  }

  // Advance schedule — snooze must not rewrite recurrence base
  getStore().update((d) => {
    const r = (d.reminders || []).find((x) => x.id === reminder.id);
    if (!r) return;
    r.lastFiredAt = Date.now();
    r.snoozeUntil = null;
    if (r.kind === 'one-off') {
      r.enabled = false;
      r.nextAt = null;
      if (!r.completedAt) r.completedAt = Date.now();
    } else {
      // Clear temporary nextAt so interval uses original `at`
      r.nextAt = nextOccurrence(
        { ...r, nextAt: null, snoozeUntil: null },
        Date.now() + 1000
      );
    }
  });
  scheduleOne(getStore().get().reminders.find((x) => x.id === reminder.id));
  emit({ type: 'alarmes:changed', ...list() });
}

function scheduleOne(reminder) {
  if (!reminder || !reminder.id) return;
  clearTimer(reminder.id);
  if (reminder.enabled === false || isCompleted(reminder)) return;
  const now = Date.now();
  let next = null;
  if (reminder.snoozeUntil && Number(reminder.snoozeUntil) > now) {
    next = Number(reminder.snoozeUntil);
  } else {
    next = reminder.nextAt || nextOccurrence(reminder, now);
  }
  if (!next) return;
  const delay = Math.max(0, next - now);
  // Cap setTimeout to ~24 days
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  const handle = setTimeout(() => {
    const fresh = (getStore().get().reminders || []).find((r) => r.id === reminder.id);
    if (!fresh || fresh.enabled === false || isCompleted(fresh)) return;
    const due =
      (fresh.snoozeUntil && Number(fresh.snoozeUntil) <= Date.now() + 500
        ? Number(fresh.snoozeUntil)
        : null) ||
      fresh.nextAt ||
      nextOccurrence(fresh, Date.now() - 1000);
    if (due && due <= Date.now() + 500) {
      fireReminder(fresh);
    } else {
      scheduleOne(fresh);
    }
  }, capped);
  timers.set(reminder.id, handle);

  getStore().update((d) => {
    const r = (d.reminders || []).find((x) => x.id === reminder.id);
    if (r && !r.snoozeUntil) r.nextAt = next;
  });
}

function rescheduleAll() {
  for (const id of [...timers.keys()]) clearTimer(id);
  for (const r of getStore().get().reminders || []) {
    if (r.enabled !== false && !isCompleted(r)) scheduleOne(r);
  }
  for (const t of getStore().get().timers || []) {
    if (t.running) scheduleCountdown(t);
  }
}

function addReminder(data) {
  const reminder = {
    id: makeId('rem'),
    title: String((data && data.title) || 'Lembrete').trim(),
    body: String((data && data.body) || ''),
    kind: (data && data.kind) || 'one-off',
    at: data && data.at != null ? Number(data.at) : Date.now() + 60000,
    timeOfDay: (data && data.timeOfDay) || '09:00',
    recur: (data && data.recur) || 'daily',
    weekdays: (data && data.weekdays) || [1, 2, 3, 4, 5],
    intervalMinutes: Number((data && data.intervalMinutes) || 0),
    intervalHours: Number((data && data.intervalHours) || 0),
    windowId: (data && data.windowId) || null,
    priority: normalizePriority(data && data.priority),
    enabled: true,
    nextAt: null,
    snoozeUntil: null,
    completedAt: null,
    lastFiredAt: null,
    createdAt: Date.now(),
  };
  reminder.nextAt = nextOccurrence(reminder, Date.now() - 1) || reminder.at;
  getStore().update((d) => {
    if (!d.reminders) d.reminders = [];
    d.reminders.push(reminder);
  });
  scheduleOne(reminder);
  emit({ type: 'alarmes:changed', ...list() });
  return reminder;
}

function updateReminder(id, fields) {
  let updated = null;
  getStore().update((d) => {
    const r = (d.reminders || []).find((x) => x.id === id);
    if (!r) return;
    const nextFields = { ...(fields || {}) };
    if (nextFields.priority != null) nextFields.priority = normalizePriority(nextFields.priority);
    Object.assign(r, nextFields);
    // Only recompute nextAt when caller did not set it explicitly
    if (!('nextAt' in (fields || {}))) {
      if (r.snoozeUntil && Number(r.snoozeUntil) > Date.now()) {
        r.nextAt = Number(r.snoozeUntil);
      } else {
        r.nextAt = nextOccurrence(r, Date.now() - 1);
      }
    }
    updated = r;
  });
  if (updated) scheduleOne(updated);
  emit({ type: 'alarmes:changed', ...list() });
  return updated;
}

function removeReminder(id) {
  clearTimer(id);
  getStore().update((d) => {
    d.reminders = (d.reminders || []).filter((r) => r.id !== id);
  });
  emit({ type: 'alarmes:changed', ...list() });
  return true;
}

function completeReminder(id) {
  return updateReminder(id, {
    enabled: false,
    completedAt: Date.now(),
    snoozeUntil: null,
    nextAt: null,
  });
}

/**
 * Snooze delays the next fire without changing recurrence base schedule
 * (kind / recur / timeOfDay / at / weekdays / interval*).
 */
function snooze(id, minutes) {
  const ms = (Number(minutes) || 5) * 60 * 1000;
  const until = Date.now() + ms;
  let updated = null;
  getStore().update((d) => {
    const r = (d.reminders || []).find((x) => x.id === id);
    if (!r) return;
    r.snoozeUntil = until;
    r.nextAt = until;
    r.enabled = true;
    if (r.completedAt) r.completedAt = null;
    updated = { ...r };
  });
  if (updated) scheduleOne(updated);
  emit({ type: 'alarmes:changed', ...list() });
  return updated;
}

/* ---- Countdown timers ---- */

function scheduleCountdown(timer) {
  clearTimer(`timer-${timer.id}`);
  if (!timer.running) return;
  const remaining = Math.max(0, (timer.endsAt || 0) - Date.now());
  const handle = setTimeout(() => {
    getStore().update((d) => {
      const t = (d.timers || []).find((x) => x.id === timer.id);
      if (t) {
        t.running = false;
        t.remainingMs = 0;
      }
    });
    const fresh = (getStore().get().timers || []).find((x) => x.id === timer.id);
    testNotificationLog.push({
      id: timer.id,
      title: timer.title || 'Timer',
      body: 'Tempo esgotado',
      at: Date.now(),
      kind: 'timer',
    });
    emit({ type: 'alarmes:timer-done', timer: fresh });
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: `MultiHeiz — ${timer.title || 'Timer'}`,
          body: 'Tempo esgotado',
        }).show();
      }
    } catch {
      /* ignore */
    }
    emit({ type: 'alarmes:changed', ...list() });
  }, remaining);
  timers.set(`timer-${timer.id}`, handle);
}

function addTimer(data) {
  const durationMs = Number((data && data.durationMs) || 60000);
  const timer = {
    id: makeId('tmr'),
    title: String((data && data.title) || 'Timer').trim(),
    durationMs,
    remainingMs: durationMs,
    endsAt: null,
    running: false,
    createdAt: Date.now(),
  };
  getStore().update((d) => {
    if (!d.timers) d.timers = [];
    d.timers.push(timer);
  });
  emit({ type: 'alarmes:changed', ...list() });
  return timer;
}

function startTimer(id) {
  let t = null;
  getStore().update((d) => {
    t = (d.timers || []).find((x) => x.id === id);
    if (!t) return;
    if (!t.remainingMs) t.remainingMs = t.durationMs;
    t.running = true;
    t.endsAt = Date.now() + t.remainingMs;
  });
  if (t) scheduleCountdown(t);
  emit({ type: 'alarmes:changed', ...list() });
  return t;
}

function pauseTimer(id) {
  clearTimer(`timer-${id}`);
  let t = null;
  getStore().update((d) => {
    t = (d.timers || []).find((x) => x.id === id);
    if (!t || !t.running) return;
    t.remainingMs = Math.max(0, (t.endsAt || Date.now()) - Date.now());
    t.running = false;
    t.endsAt = null;
  });
  emit({ type: 'alarmes:changed', ...list() });
  return t;
}

function resetTimer(id) {
  clearTimer(`timer-${id}`);
  let t = null;
  getStore().update((d) => {
    t = (d.timers || []).find((x) => x.id === id);
    if (!t) return;
    t.running = false;
    t.remainingMs = t.durationMs;
    t.endsAt = null;
  });
  emit({ type: 'alarmes:changed', ...list() });
  return t;
}

function removeTimer(id) {
  clearTimer(`timer-${id}`);
  getStore().update((d) => {
    d.timers = (d.timers || []).filter((x) => x.id !== id);
  });
  emit({ type: 'alarmes:changed', ...list() });
  return true;
}

/**
 * On app start: find reminders that should have fired since lastRunAt.
 */
function detectMissed() {
  const d = getStore().get();
  const last = Number(d.lastRunAt) || 0;
  const now = Date.now();
  const missed = [];
  for (const r of d.reminders || []) {
    if (r.enabled === false || isCompleted(r)) continue;
    if (r.kind === 'one-off' && r.at && r.at > last && r.at <= now) {
      missed.push({ ...r });
      r.enabled = false;
      r.lastFiredAt = r.at;
      r.nextAt = null;
      r.snoozeUntil = null;
      r.completedAt = r.at;
    } else if (r.kind === 'recurring') {
      const next = nextOccurrence(r, last);
      if (next && next <= now) {
        missed.push({ ...r, missedAt: next });
        r.lastFiredAt = next;
        r.snoozeUntil = null;
        r.nextAt = nextOccurrence(r, now);
      }
    }
  }
  d.lastRunAt = now;
  getStore().scheduleSave();
  rescheduleAll();
  return missed;
}

/**
 * One grouped OS notification for missed reminders + entry in test log.
 */
function notifyMissedGroup(missed) {
  if (!missed || !missed.length) return null;
  const count = missed.length;
  const title = count === 1 ? missed[0].title || 'Lembrete perdido' : `${count} lembretes perdidos`;
  const body = missed
    .map((m) => m.title || 'Lembrete')
    .slice(0, 8)
    .join(', ');
  const entry = {
    kind: 'missed-group',
    title,
    body,
    count,
    ids: missed.map((m) => m.id),
    at: Date.now(),
  };
  testNotificationLog.push(entry);
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `MultiHeiz — ${title}`,
        body: body || 'Abrir lista de lembretes',
        silent: false,
      });
      n.on('click', () => {
        emit({ type: 'alarmes:missed', missed });
      });
      n.show();
    }
  } catch (err) {
    console.warn('[alarmes] missed group notification failed', err && err.message);
  }
  return entry;
}

function markStarted() {
  getStore().update((d) => {
    d.lastRunAt = Date.now();
  });
}

function getTestNotificationLog() {
  return [...testNotificationLog];
}

function clearTestNotificationLog() {
  testNotificationLog = [];
}

function flush() {
  if (store) store.flush();
}

function stopAll() {
  for (const id of [...timers.keys()]) clearTimer(id);
}

module.exports = {
  init,
  list,
  addReminder,
  updateReminder,
  removeReminder,
  completeReminder,
  snooze,
  addTimer,
  startTimer,
  pauseTimer,
  resetTimer,
  removeTimer,
  nextOccurrence,
  detectMissed,
  notifyMissedGroup,
  markStarted,
  getTestNotificationLog,
  clearTestNotificationLog,
  flush,
  stopAll,
  rescheduleAll,
  filterByView,
  sortByPriorityThenNext,
  effectiveNextAt,
  normalizePriority,
  PRIORITY_RANK,
};
