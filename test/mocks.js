
// Stubs JSON-2 que interceptan las llamadas a Odoo durante los tests.
// Se carga antes de importar agent.js.

import { mock } from 'node:test';

// Credenciales ficticias: nunca se utilizan en producción.
process.env.WHATSAPP_APP_SECRET ??= 'test-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN ??= 'test-verify-token';
process.env.WHATSAPP_TOKEN ??= 'test-whatsapp-token';
process.env.ODOO_URL ??= 'https://odoo.test';
process.env.ODOO_DB ??= 'Conexus_Test';
process.env.ODOO_EMAIL ??= 'test@example.com';
process.env.ODOO_API_KEY ??= 'test-api-key';

const originalFetch = globalThis.fetch;

export const lastLead = { value: null };

export function resetLastLead() {
  lastLead.value = null;
}

const EXISTING_PHONE_SUFFIX = '5500000009';

function json(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

globalThis.fetch = async function mockedFetch(url, options = {}) {
  const urlString = String(url);

  // Compatibilidad temporal con llamadas JSON-RPC antiguas.
  if (urlString.includes('/jsonrpc')) {
    return json({ result: false });
  }

  if (!urlString.includes('/json/2/')) {
    return originalFetch(url, options);
  }

  const match = urlString.match(/\/json\/2\/([^/]+)\/([^/?]+)/);

  if (!match) {
    throw new Error(`Ruta JSON-2 no reconocida: ${urlString}`);
  }

  const [, model, method] = match;
  const body = options.body ? JSON.parse(options.body) : {};

  // Contactos
  if (model === 'res.partner' && method === 'search_read') {
    const domain = JSON.stringify(body.domain || []);
    const found = domain.includes(EXISTING_PHONE_SUFFIX);

    return json(found
      ? [{
          id: 1,
          display_name: 'Cliente Existente',
          user_id: [5, 'Vendedor Uno'],
        }]
      : []);
  }

  // Equipos comerciales
  if (model === 'crm.team' && method === 'search_read') {
    return json([{
      id: 1,
      name: 'Sales',
      user_id: [7, 'Lider Equipo'],
    }]);
  }

  // Leads
  if (model === 'crm.lead' && method === 'search') {
    return json([]);
  }

  if (model === 'crm.lead' && method === 'search_read') {
    return json([]);
  }

  if (model === 'crm.lead' && method === 'create') {
    lastLead.value = body.vals_list?.[0] ?? null;
    return json(9999);
  }

  if (model === 'crm.lead' && method === 'message_post') {
    return json(true);
  }

  // Etiquetas
  if (model === 'crm.tag' && method === 'search') {
    return json([7]);
  }

  if (model === 'crm.tag' && method === 'create') {
    return json(7);
  }

  // Usuario asignado
  if (model === 'res.users' && method === 'read') {
    return json([{
      id: 5,
      name: 'Vendedor',
      partner_id: [10, 'Vendedor'],
      email: 'v@example.com',
    }]);
  }

  // Modelo CRM
  if (model === 'ir.model' && method === 'search_read') {
    return json([{ id: 421 }]);
  }

  // Tipo de actividad
  if (model === 'ir.model.data' && method === 'search_read') {
    return json([{ res_id: 4 }]);
  }

  if (model === 'mail.activity.type' && method === 'search_read') {
    return json([{ id: 4 }]);
  }

  // Actividad comercial
  if (model === 'mail.activity' && method === 'create') {
    return json(500);
  }

  throw new Error(`Mock JSON-2 sin implementar: ${model}.${method}`);
};

// Evita advertencias por importación del módulo de tests.
void mock;
