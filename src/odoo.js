// Cliente JSON-RPC para Odoo (Enterprise y Community, v14+ probado hasta v17).
// Usa el endpoint /jsonrpc con service "common" para autenticar y "object"
// para execute_kw (buscar partners y crear leads de CRM).

import { config } from './config.js';

let uidCache = null;

async function rpc(method, params) {
  const res = await fetch(`${config.odoo.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }),
  });
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (data.error) {
    const err = data.error.data || {};
    throw new Error(`Odoo ${data.error.code}: ${err.message || data.error.message}`);
  }
  return data.result;
}

/** Autentica en Odoo y guarda el uid en memoria. */
export async function authenticate() {
  if (uidCache) return uidCache;
  const uid = await rpc('call', {
    service: 'common',
    method: 'login',
    args: [config.odoo.db, config.odoo.email, config.odoo.apiKey],
  });
  if (!uid) throw new Error('Autenticación en Odoo fallida (revisa ODOO_URL, ODOO_DB, ODOO_EMAIL, ODOO_API_KEY)');
  uidCache = uid;
  return uid;
}

async function executeKw(model, method, args, kwargs = {}) {
  const uid = await authenticate();
  return rpc('call', {
    service: 'object',
    method: 'execute_kw',
    args: [config.odoo.db, uid, config.odoo.apiKey, model, method, args, kwargs],
  });
}

/**
 * Busca un partner activo por teléfono/whatsapp (similar a lo que hace el
 * módulo WhatsApp de Odoo). Devuelve { id, name, userId } o false.
 */
export async function findPartnerByPhone(phone) {
  const digits = String(phone).replace(/[^\d+]/g, '');
  const suffix = digits.slice(-10);
  let ids;
  try {
    ids = await executeKw('res.partner', 'search', [
      ['|', ['phone', 'ilike', suffix], ['mobile', 'ilike', suffix]],
    ], { limit: 1 });
  } catch (err) {
    // Odoo 19 eliminó res.partner.mobile: se reintenta solo con phone.
    if (!/mobile/i.test(err.message)) throw err;
    ids = await executeKw('res.partner', 'search', [[['phone', 'ilike', suffix]]], { limit: 1 });
  }
  if (!ids.length) return false;
  const [partner] = await executeKw('res.partner', 'read', [ids, ['display_name', 'user_id']]);
  return {
    id: ids[0],
    name: partner?.display_name || '',
    userId: partner?.user_id?.[0] || null,
  };
}

let teamCache = null;
let teamCachedAt = 0;

/** Equipo de ventas configurado (o el primero con líder). */
async function getSalesTeam() {
  if (teamCache && Date.now() - teamCachedAt < 5 * 60 * 1000) return teamCache;
  const domain = config.odoo.teamId
    ? [['id', '=', config.odoo.teamId]]
    : [['user_id', '!=', false]];
  const [team] = await executeKw('crm.team', 'search_read', [domain, ['name', 'user_id']], {
    limit: 1,
    order: 'id asc',
  });
  teamCache = team
    ? { id: team.id, name: team.name, userId: team.user_id?.[0] || null }
    : null;
  teamCachedAt = Date.now();
  return teamCache;
}

/**
 * Regla de asignación:
 * 1. Si el contacto existe y tiene vendedor (res.partner.user_id), se le asigna.
 * 2. Si no, el lead va al líder del equipo de ventas.
 */
export async function resolveAssignment(partner) {
  if (partner?.userId) {
    return { userId: partner.userId, teamId: null, source: 'vendedor del contacto' };
  }
  const team = await getSalesTeam();
  if (team?.userId) {
    return { userId: team.userId, teamId: team.id, source: 'líder del equipo' };
  }
  return { userId: false, teamId: team?.id || false, source: 'sin asignar' };
}

/** Busca un lead ya creado para una entrega de WhatsApp (idempotencia). */
export async function findLeadByRef(ref) {
  if (!ref) return null;
  const ids = await executeKw('crm.lead', 'search', [[['description', 'ilike', ref]]], { limit: 1 });
  return ids[0] || null;
}

/** Crea el lead en crm.lead y devuelve su id. */
export async function createLead({
  name,
  phone,
  description,
  partnerId = false,
  tags = [],
  userId = false,
  teamId = false,
  ref = null,
}) {
  if (ref) {
    const existing = await findLeadByRef(ref);
    if (existing) return existing;
  }

  const uid = await authenticate();
  const tagIds = await resolveTagNames(tags, uid);

  const values = {
    name,
    type: 'lead',
    phone,
    partner_id: partnerId || false,
    description,
    tag_ids: [[6, 0, tagIds]],
  };
  if (userId) values.user_id = userId;
  if (teamId) values.team_id = teamId;

  return executeKw('crm.lead', 'create', [values]);
}

let crmModelIdCache;

/** ID de ir.model para crm.lead (Odoo 19 exige res_model_id en actividades). */
async function getCrmModelId() {
  if (crmModelIdCache !== undefined) return crmModelIdCache;
  try {
    const [model] = await executeKw(
      'ir.model',
      'search_read',
      [[['model', '=', 'crm.lead']], ['id']],
      { limit: 1 }
    );
    crmModelIdCache = model?.id || false;
  } catch {
    crmModelIdCache = false;
  }
  return crmModelIdCache;
}

let callActivityTypeCache;

/** ID del tipo de actividad "Llamada" de Odoo (o false si no existe). */
async function getCallActivityTypeId() {
  if (callActivityTypeCache !== undefined) return callActivityTypeCache;
  try {
    const [data] = await executeKw(
      'ir.model.data',
      'search_read',
      [[['module', '=', 'mail'], ['name', '=', 'mail_activity_data_call']], ['res_id']],
      { limit: 1 }
    );
    if (data?.res_id) return (callActivityTypeCache = data.res_id);
  } catch {
    // sin permiso para leer ir.model.data: se intenta por nombre
  }
  try {
    const [type] = await executeKw(
      'mail.activity.type',
      'search_read',
      [[['name', 'ilike', 'llam']], ['id']],
      { limit: 1 }
    );
    callActivityTypeCache = type?.id || false;
  } catch {
    callActivityTypeCache = false;
  }
  return callActivityTypeCache;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Notifica al vendedor asignado: crea una actividad de llamada y publica en el
 * chatter del lead mencionándolo (notificación en Odoo).
 */
export async function notifyLeadAssignee({ leadId, userId, customerName, phone, source }) {
  if (!userId || !leadId) return false;

  const [user] = await executeKw('res.users', 'read', [[userId], ['name', 'partner_id', 'email']]);
  const assigneeName = user?.name || `usuario ${userId}`;
  const activityTypeId = await getCallActivityTypeId();

  if (activityTypeId) {
    const activity = {
      res_id: leadId,
      user_id: userId,
      activity_type_id: activityTypeId,
      summary: `Contactar a ${customerName} por WhatsApp`,
      date_deadline: new Date().toISOString().slice(0, 10),
    };
    const modelId = await getCrmModelId();
    if (modelId) activity.res_model_id = modelId;
    else activity.res_model = 'crm.lead';

    try {
      await executeKw('mail.activity', 'create', [activity]);
    } catch (err) {
      // Odoo ≤18 no conoce res_model_id: se reintenta con el campo clásico.
      if (modelId && /res_model_id/i.test(err.message)) {
        delete activity.res_model_id;
        activity.res_model = 'crm.lead';
        await executeKw('mail.activity', 'create', [activity]);
      } else {
        throw err;
      }
    }
  }

  const body = [
    `<p><b>Nuevo lead de WhatsApp</b> asignado a ${escapeHtml(assigneeName)}.</p>`,
    `<p>Cliente: ${escapeHtml(customerName)}<br/>`,
    `Teléfono: ${escapeHtml(phone)}<br/>`,
    `Asignado por: ${escapeHtml(source)}</p>`,
  ].join('');

  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
    partner_ids: user?.partner_id ? [user.partner_id[0]] : [],
    body_is_html: true,
  });

  return true;
}

/** Crea (o reutiliza) etiquetas en crm.tag por nombre. */
async function resolveTagNames(tagNames, uid) {
  if (!tagNames || !tagNames.length) return [];
  const ids = [];
  for (const name of tagNames) {
    const found = await executeKw('crm.tag', 'search', [[['name', '=', name]]], { limit: 1 });
    if (found.length) {
      ids.push(found[0]);
    } else {
      try {
        ids.push(await executeKw('crm.tag', 'create', [{ name }]));
      } catch {
        // Sin permisos para crear etiquetas: lo ignoramos y seguimos.
      }
    }
  }
  return ids;
}

/** Añade una nota al lead existente (usado en escalamiento a humano). */
export async function addNoteToLead(leadId, note) {
  await executeKw('crm.lead', 'message_post', [[leadId]], {
    body: note,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_note',
  });
}


/**
 * Prueba de conexión con Odoo 19 mediante JSON-2.
 * Solo lectura: consulta un ID de crm.lead.
 */
export async function testJson2Connection() {
  const { url, db, apiKey } = config.odoo;

  const response = await fetch(`${url}/json/2/crm.lead/search_read`, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${apiKey}`,
      'X-Odoo-Database': db,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      domain: [],
      fields: ['id'],
      limit: 1,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`JSON-2 HTTP ${response.status}: ${error}`);
  }

  const records = await response.json();

  return {
    connected: true,
    recordsFound: records.length,
  };
}
