
// Cliente JSON-2 para Odoo 19.
// Conserva las funciones utilizadas por agent.js.

import { config } from './config.js';

const JSON2_URL = `${config.odoo.url}/json/2`;

async function json2(model, method, params = {}) {
  const { db, apiKey } = config.odoo;

  if (!config.odoo.url || !db || !apiKey) {
    throw new Error('Configuración de Odoo incompleta');
  }

  const response = await fetch(`${JSON2_URL}/${model}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `bearer ${apiKey}`,
      'X-Odoo-Database': db,
      'User-Agent': 'Conexus-WhatsApp-Agent/1.0',
    },
    body: JSON.stringify(params),
  });

  const raw = await response.text();

  let result;
  try {
    result = raw ? JSON.parse(raw) : null;
  } catch {
    result = raw;
  }

  if (!response.ok) {
    const message =
      result?.message ||
      result?.arguments?.[0] ||
      result?.name ||
      raw ||
      'Error desconocido';

    throw new Error(`Odoo JSON-2 HTTP ${response.status}: ${message}`);
  }

  return result;
}

function normalizeId(result) {
  if (Number.isInteger(result)) return result;
  if (Array.isArray(result)) return result[0] || false;
  if (result && Number.isInteger(result.id)) return result.id;
  return false;
}

/**
 * Prueba de conexión JSON-2.
 * Solo lectura.
 */
export async function testJson2Connection() {
  const records = await json2('crm.lead', 'search_read', {
    domain: [],
    fields: ['id'],
    limit: 1,
  });

  return {
    connected: true,
    recordsFound: records.length,
  };
}

/**
 * Busca un contacto por teléfono o móvil.
 */
export async function findPartnerByPhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const suffix = digits.slice(-10);

  if (!suffix) return false;

  let partners;

  try {
    partners = await json2('res.partner', 'search_read', {
      domain: [
        '|',
        ['phone', 'ilike', suffix],
        ['mobile', 'ilike', suffix],
      ],
      fields: ['display_name', 'user_id'],
      limit: 1,
    });
  } catch (err) {
    // Compatibilidad con instalaciones donde mobile no está disponible.
    if (!/mobile/i.test(err.message)) throw err;

    partners = await json2('res.partner', 'search_read', {
      domain: [['phone', 'ilike', suffix]],
      fields: ['display_name', 'user_id'],
      limit: 1,
    });
  }

  const partner = partners[0];

  if (!partner) return false;

  return {
    id: partner.id,
    name: partner.display_name || '',
    userId: partner.user_id?.[0] || null,
  };
}

let teamCache = null;
let teamCachedAt = 0;

/**
 * Obtiene el equipo comercial configurado.
 */
async function getSalesTeam() {
  if (teamCache && Date.now() - teamCachedAt < 5 * 60 * 1000) {
    return teamCache;
  }

  const domain = config.odoo.teamId
    ? [['id', '=', config.odoo.teamId]]
    : [['user_id', '!=', false]];

  const teams = await json2('crm.team', 'search_read', {
    domain,
    fields: ['name', 'user_id'],
    limit: 1,
    order: 'id asc',
  });

  const team = teams[0];

  teamCache = team
    ? {
        id: team.id,
        name: team.name,
        userId: team.user_id?.[0] || null,
      }
    : null;

  teamCachedAt = Date.now();

  return teamCache;
}

/**
 * Resuelve el vendedor responsable del lead.
 */
export async function resolveAssignment(partner) {
  if (partner?.userId) {
    return {
      userId: partner.userId,
      teamId: null,
      source: 'vendedor del contacto',
    };
  }

  const team = await getSalesTeam();

  if (team?.userId) {
    return {
      userId: team.userId,
      teamId: team.id,
      source: 'líder del equipo',
    };
  }

  return {
    userId: false,
    teamId: team?.id || false,
    source: 'sin asignar',
  };
}

/**
 * Busca un lead por referencia de WhatsApp.
 */
export async function findLeadByRef(ref) {
  if (!ref) return null;

  const ids = await json2('crm.lead', 'search', {
    domain: [['description', 'ilike', ref]],
    limit: 1,
  });

  return ids[0] || null;
}

/**
 * Crea un lead en CRM.
 */
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

  const tagIds = await resolveTagNames(tags);

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

  const result = await json2('crm.lead', 'create', {
    vals_list: [values],
  });

  const leadId = normalizeId(result);

  if (!leadId) {
    throw new Error('Odoo no devolvió un ID válido al crear el lead');
  }

  return leadId;
}

/**
 * Obtiene el ID del modelo crm.lead.
 */
let crmModelIdCache;

async function getCrmModelId() {
  if (crmModelIdCache !== undefined) return crmModelIdCache;

  try {
    const models = await json2('ir.model', 'search_read', {
      domain: [['model', '=', 'crm.lead']],
      fields: ['id'],
      limit: 1,
    });

    crmModelIdCache = models[0]?.id || false;
  } catch {
    crmModelIdCache = false;
  }

  return crmModelIdCache;
}

/**
 * Busca el tipo de actividad llamada.
 */
let callActivityTypeCache;

async function getCallActivityTypeId() {
  if (callActivityTypeCache !== undefined) {
    return callActivityTypeCache;
  }

  try {
    const data = await json2('ir.model.data', 'search_read', {
      domain: [
        ['module', '=', 'mail'],
        ['name', '=', 'mail_activity_data_call'],
      ],
      fields: ['res_id'],
      limit: 1,
    });

    if (data[0]?.res_id) {
      callActivityTypeCache = data[0].res_id;
      return callActivityTypeCache;
    }
  } catch {
    // Se intenta buscar por nombre.
  }

  try {
    const types = await json2('mail.activity.type', 'search_read', {
      domain: [['name', 'ilike', 'llam']],
      fields: ['id'],
      limit: 1,
    });

    callActivityTypeCache = types[0]?.id || false;
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
 * Notifica al vendedor mediante actividad y chatter.
 */
export async function notifyLeadAssignee({
  leadId,
  userId,
  customerName,
  phone,
  source,
}) {
  if (!userId || !leadId) return false;

  const users = await json2('res.users', 'read', {
    ids: [userId],
    fields: ['name', 'partner_id', 'email'],
  });

  const user = users[0];

  const assigneeName = user?.name || `usuario ${userId}`;
  const activityTypeId = await getCallActivityTypeId();

  if (activityTypeId) {
    const modelId = await getCrmModelId();

    if (modelId) {
      const activity = {
        res_model_id: modelId,
        res_id: leadId,
        user_id: userId,
        activity_type_id: activityTypeId,
        summary: `Contactar a ${customerName} por WhatsApp`,
        date_deadline: new Date().toISOString().slice(0, 10),
      };

      await json2('mail.activity', 'create', {
        vals_list: [activity],
      });
    } else {
      console.warn('[odoo] No se pudo obtener ir.model para crm.lead');
    }
  }

  const body = [
    `<p><b>Nuevo lead de WhatsApp</b> asignado a ${escapeHtml(assigneeName)}.</p>`,
    `<p>Cliente: ${escapeHtml(customerName)}<br/>`,
    `Teléfono: ${escapeHtml(phone)}<br/>`,
    `Asignado por: ${escapeHtml(source)}</p>`,
  ].join('');

  await json2('crm.lead', 'message_post', {
    ids: [leadId],
    body,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
    partner_ids: user?.partner_id ? [user.partner_id[0]] : [],
  });

  return true;
}

/**
 * Busca o crea etiquetas CRM.
 */
async function resolveTagNames(tagNames) {
  if (!tagNames || !tagNames.length) return [];

  const ids = [];

  for (const name of tagNames) {
    const found = await json2('crm.tag', 'search', {
      domain: [['name', '=', name]],
      limit: 1,
    });

    if (found.length) {
      ids.push(found[0]);
      continue;
    }

    try {
      const result = await json2('crm.tag', 'create', {
        vals_list: [{ name }],
      });

      const tagId = normalizeId(result);
      if (tagId) ids.push(tagId);
    } catch (err) {
      console.warn(`[odoo] No se pudo crear la etiqueta ${name}:`, err.message);
    }
  }

  return ids;
}

/**
 * Añade una nota al chatter de un lead.
 */
export async function addNoteToLead(leadId, note) {
  await json2('crm.lead', 'message_post', {
    ids: [leadId],
    body: note,
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_note',
  });
}
