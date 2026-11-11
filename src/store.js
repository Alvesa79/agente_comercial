// Estado persistente del agente: sesiones, mensajes ya procesados y cola de leads.
// Se guarda en un JSON con escritura atómica para sobrevivir reinicios.
// Para varias instancias, sustituir este módulo por un adaptador de Redis/Postgres.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE =
  process.env.STATE_FILE || path.resolve(process.cwd(), '.data', 'state.json');
const MEMORY_ONLY =
  Boolean(process.env.NODE_TEST_CONTEXT) || process.env.STATE_FILE === ':memory:';

const emptyState = () => ({ sessions: {}, processed: {}, outbox: [] });

let state = emptyState();
let loaded = false;

function load() {
  if (loaded) return state;
  loaded = true;
  if (MEMORY_ONLY) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...emptyState(), ...raw };
    state.sessions ||= {};
    state.processed ||= {};
    state.outbox ||= [];
  } catch {
    state = emptyState();
  }
  return state;
}

function persist() {
  if (MEMORY_ONLY) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[store] No se pudo guardar el estado:', err.message);
  }
}

// ---- Sesiones de conversación ----

export function pruneSessions(ttlMs, now = Date.now()) {
  load();
  let changed = false;
  for (const [phone, session] of Object.entries(state.sessions)) {
    if (now - (session.updatedAt || 0) > ttlMs) {
      delete state.sessions[phone];
      changed = true;
    }
  }
  if (changed) persist();
}

export function getStoredSession(phone) {
  load();
  const session = state.sessions[phone];
  if (!session) return null;
  return { step: session.step, data: session.data || {} };
}

export function saveSession(phone, session) {
  load();
  state.sessions[phone] = {
    step: session.step,
    data: session.data || {},
    updatedAt: Date.now(),
  };
  persist();
}

export function deleteStoredSession(phone) {
  load();
  if (!state.sessions[phone]) return;
  delete state.sessions[phone];
  persist();
}

// ---- Idempotencia de webhooks (Meta reintenta entregas) ----

export function claimMessage(waMessageId, ttlMs = 24 * 60 * 60 * 1000) {
  if (!waMessageId) return true;
  load();
  const now = Date.now();
  let changed = false;
  for (const [id, ts] of Object.entries(state.processed)) {
    if (now - ts > ttlMs) {
      delete state.processed[id];
      changed = true;
    }
  }
  if (state.processed[waMessageId]) {
    if (changed) persist();
    return false;
  }
  state.processed[waMessageId] = now;
  persist();
  return true;
}

// ---- Cola de leads cuando Odoo no responde ----

export function enqueueOutbox(entry) {
  load();
  const ref = entry.ref || crypto.randomUUID();
  if (state.outbox.some((e) => e.ref === ref)) return ref;
  state.outbox.push({
    phone: entry.phone,
    data: entry.data,
    handoff: Boolean(entry.handoff),
    ref,
    attempts: 0,
    nextAttempt: 0,
    createdAt: Date.now(),
  });
  persist();
  return ref;
}

export function pendingOutbox(now = Date.now()) {
  load();
  return state.outbox.filter((entry) => entry.nextAttempt <= now);
}

export function updateOutbox(ref, patch) {
  load();
  const entry = state.outbox.find((e) => e.ref === ref);
  if (!entry) return;
  Object.assign(entry, patch);
  persist();
}

export function removeOutbox(ref) {
  load();
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((e) => e.ref !== ref);
  if (state.outbox.length !== before) persist();
}

export function outboxSize() {
  load();
  return state.outbox.length;
}
