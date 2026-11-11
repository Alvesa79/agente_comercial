// Motor de conversación del agente comercial.
// Flujo: saludo -> nombre -> necesidad -> presupuesto -> ubicación -> lead.
// Las sesiones y la cola de leads se persisten en disco (src/store.js).

import {
  findPartnerByPhone,
  findLeadByRef,
  createLead,
  resolveAssignment,
  notifyLeadAssignee,
  addNoteToLead,
} from './odoo.js';
import { classifyWithLlm } from './llm.js';
import { llmConfigured } from './config.js';
import {
  pruneSessions,
  getStoredSession,
  saveSession,
  deleteStoredSession,
  enqueueOutbox,
  pendingOutbox,
  updateOutbox,
  removeOutbox,
} from './store.js';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min de inactividad cierra la sesión

export function getSession(phone) {
  pruneSessions(SESSION_TTL_MS);
  let session = getStoredSession(phone);
  if (!session) {
    session = { step: 'START', data: {} };
    saveSession(phone, session);
  }
  return session;
}

export function resetSession(phone) {
  deleteStoredSession(phone);
}

/** Devuelve el texto a enviar al cliente según el paso actual. */
export function nextMessage(session) {
  switch (session.step) {
    case 'START': return '¡Hola! 👋 Soy el asistente comercial. Para empezar, ¿cuál es tu nombre completo?';
    case 'NAME': return 'Con gusto. ¿Cuál es tu nombre completo?';
    case 'NEED': return `Gracias, ${session.data.name}. ¿Qué producto o servicio te interesa?`;
    case 'BUDGET': return '¿Qué presupuesto aproximado tienes en mente? (puedes decir "no lo sé")';
    case 'LOCATION': return '¿En qué ciudad o zona estás?';
    case 'DONE': return 'Listo ✅ tu solicitud quedó registrada. Un asesor te contactará por WhatsApp a la brevedad. ¿Algo más en lo que te pueda ayudar?';
    default: return 'Un asesor humano se pondrá en contacto contigo pronto.';
  }
}

function looksLikeHumanRequest(text) {
  return /(asesor|humano|persona real|gustaria hablar con alguien|hablar con un)/i.test(text || '');
}

/**
 * Procesa el mensaje entrante y decide si crear el lead en Odoo.
 * `reply` es lo que hay que responder al cliente en este paso; el webhook solo
 * lo reemplaza por el mensaje final cuando hay handoff, lead o error.
 * @param {string} phone
 * @param {string} text
 * @param {{waMessageId?: string}} [meta]
 * @returns {Promise<{leadId: number|null, createError: Error|null, handoff: boolean, queued: boolean, reply: string|null}>}
 */
export async function handleIncomingMessage(phone, text, meta = {}) {
  const session = getSession(phone);
  const waMessageId = meta.waMessageId || null;

  if (looksLikeHumanRequest(text) && session.step !== 'START') {
    session.step = 'HANDOFF';
    saveSession(phone, session);
    const result = await finalizeLead(session.data, phone, { ref: waMessageId, handoff: true });
    return { ...result, handoff: true, reply: null };
  }

  // Comandos de salida: el cliente no quiere seguir el flujo.
  if (/^(cancelar|salir|stop)/i.test(text)) {
    resetSession(phone);
    return {
      leadId: null,
      createError: null,
      handoff: false,
      queued: false,
      reply: 'Entendido. Si necesitas algo más, escríbeme cuando quieras. 👋',
    };
  }

  let result = { leadId: null, createError: null, queued: false };
  let reply = null;

  switch (session.step) {
    case 'START':
      reply = nextMessage(session); // saludo + nombre, calculado antes de avanzar
      session.step = 'NAME';
      break;
    case 'NAME':
      session.data.name = text.trim();
      session.step = 'NEED';
      reply = nextMessage(session);
      break;
    case 'NEED':
      try {
        const nlp = await extractIntent(text);
        session.data.need = nlp.need || text.trim();
        session.data.category = nlp.category || 'General';
      } catch (err) {
        console.error('[agent] Error en LLM, uso el texto crudo:', err.message);
        session.data.need = text.trim();
        session.data.category = 'General';
      }
      session.step = 'BUDGET';
      reply = nextMessage(session);
      break;
    case 'BUDGET':
      session.data.budget = /no (lo )?s[eé]/i.test(text) ? 'Por definir' : text.trim();
      session.step = 'LOCATION';
      reply = nextMessage(session);
      break;
    case 'LOCATION':
      session.data.location = text.trim();
      // Fin del flujo: crear el lead (o encolarlo si Odoo no responde).
      result = await finalizeLead(session.data, phone, { ref: waMessageId });
      session.step = 'DONE';
      break;
    case 'DONE': {
      // Reinicio de conversación sobre el lead ya creado.
      resetSession(phone);
      const fresh = getSession(phone);
      reply = nextMessage(fresh);
      fresh.step = 'NAME';
      saveSession(phone, fresh);
      break;
    }
    default:
      break;
  }

  saveSession(phone, session);
  return { ...result, handoff: false, reply };
}

/** Crea el lead y, si falla, lo deja en la cola para reintentar. */
async function finalizeLead(data, phone, { ref = null, handoff = false } = {}) {
  try {
    const leadId = await createLeadFor(data, phone, { ref, handoff });
    return { leadId, createError: null, queued: false };
  } catch (err) {
    console.error('[agent] Error creando lead en Odoo:', err.message);
    try {
      enqueueOutbox({ phone, data, ref, handoff });
      return { leadId: null, createError: err, queued: true };
    } catch (queueErr) {
      console.error('[agent] No se pudo encolar el lead:', queueErr.message);
      return { leadId: null, createError: err, queued: false };
    }
  }
}

async function createLeadFor(data, phone, { ref = null, handoff = false } = {}) {
  // Si Meta reintentó y el lead ya se creó, no duplicamos ni notificamos otra vez.
  if (ref) {
    try {
      const existing = await findLeadByRef(ref);
      if (existing) return existing;
    } catch (err) {
      console.warn('[odoo] No se pudo comprobar el lead existente:', err.message);
    }
  }

  let partner = false;
  try {
    partner = await findPartnerByPhone(phone);
  } catch (err) {
    console.warn('[odoo] No se pudo deduplicar el partner:', err.message);
  }

  const assignment = await resolveAssignment(partner);
  const name = `${data.name || 'Cliente WhatsApp'} - ${data.need || 'Solicitud por WhatsApp'}`.slice(0, 80);
  const description = [
    `Nombre: ${data.name || 'No indicado'}`,
    `Necesidad: ${data.need || 'Solicitud por WhatsApp'}`,
    `Categoría estimada: ${data.category || 'General'}`,
    `Presupuesto: ${data.budget || 'Por definir'}`,
    `Ubicación: ${data.location || 'Sin especificar'}`,
    `Teléfono (WhatsApp): ${phone}`,
    'Fuente: Agente IA de WhatsApp',
  ];
  if (partner) description.push(`Contacto existente: ${partner.name} (#${partner.id})`);
  if (handoff) description.push('El cliente solicitó hablar con un asesor humano.');
  if (ref) description.push(`Ref. WhatsApp: ${ref}`);

  const leadId = await createLead({
    name,
    phone,
    description: description.join('\n'),
    partnerId: partner?.id || false,
    tags: ['WhatsApp', data.category || 'General'],
    userId: assignment.userId,
    teamId: assignment.teamId,
    ref,
  });

  console.log(
    `[odoo] Lead ${leadId} asignado a user_id=${assignment.userId || 'ninguno'} (${assignment.source})`
  );

  try {
    await notifyLeadAssignee({
      leadId,
      userId: assignment.userId,
      customerName: data.name || 'Cliente WhatsApp',
      phone,
      source: assignment.source,
    });
  } catch (err) {
    console.warn('[odoo] Lead creado, pero no se pudo notificar al vendedor:', err.message);
  }

  return leadId;
}

/** Reintenta los leads que quedaron en cola porque Odoo no respondió. */
export async function processOutbox() {
  for (const entry of pendingOutbox()) {
    try {
      const leadId = await createLeadFor(entry.data, entry.phone, {
        ref: entry.ref,
        handoff: entry.handoff,
      });
      removeOutbox(entry.ref);
      console.log(`[outbox] Lead ${leadId} creado al reintentar (${entry.ref})`);
    } catch (err) {
      const attempts = (entry.attempts || 0) + 1;
      const delay = Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** (attempts - 1));
      updateOutbox(entry.ref, {
        attempts,
        nextAttempt: Date.now() + delay,
        lastError: err.message,
      });
      console.warn(`[outbox] Reintento ${attempts} falló (${entry.ref}): ${err.message}`);
    }
  }
}

/** Extrae la intención con LLM si está configurado; si no, heurística simple. */
async function extractIntent(text) {
  if (llmConfigured()) {
    try {
      return await classifyWithLlm(text);
    } catch (err) {
      console.warn('[llm] Falló la clasificación, uso heurística:', err.message);
    }
  }
  // Heurística por reglas: muy básica pero suficiente para arrancar sin LLM.
  const lower = text.toLowerCase();
  const rules = [
    { test: /(seguro|póliza|poliza)/, category: 'Seguros' },
    { test: /(casa|apartamento|departamento|inmueble)/, category: 'Inmobiliaria' },
    { test: /(auto|coche|veh[cíi]culo)/, category: 'Automotriz' },
    { test: /(curso|clase|capacitaci[oó]n)/, category: 'Educación' },
    { test: /(servicio|software|sistema)/, category: 'Servicios' },
  ];
  const matched = rules.find((r) => r.test.test(lower));
  return { need: text.trim(), category: matched ? matched.category : 'General' };
}

/** Añade una nota al lead existente (usado en escalamiento a humano). */
export async function noteToLead(leadId, message) {
  await addNoteToLead(leadId, message);
}
