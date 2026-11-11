// Stubs que interceptan las llamadas a Odoo y a WhatsApp durante los tests.
// Se registran antes de importar src/odoo.js en cualquier punto del flujo.

import { mock } from 'node:test';

const originalFetch = globalThis.fetch;

// Último payload enviado a crm.lead.create, para inspeccionarlo en los tests.
export const lastLead = { value: null };

export function resetLastLead() {
  lastLead.value = null;
}

const EXISTING_PHONE_SUFFIX = '5500000009';

globalThis.fetch = async function mockedFetch(url, options) {
  const body = options?.body ? JSON.parse(options.body) : {};

  if (String(url).includes('/jsonrpc')) {
    const { service, method, args } = body.params || {};
    if (service === 'common' && method === 'login') return Promise.resolve(json({ id: 1, result: 2 }));

    if (service === 'object' && method === 'execute_kw') {
      const [, , , model, execMethod, execArgs] = args;

      if (model === 'res.partner' && execMethod === 'search') {
        const domain = JSON.stringify(execArgs);
        const found = domain.includes(EXISTING_PHONE_SUFFIX);
        return Promise.resolve(json({ result: found ? [1] : [] }));
      }
      if (model === 'res.partner' && execMethod === 'read') {
        return Promise.resolve(json({
          result: [{ id: 1, display_name: 'Cliente Existente', user_id: [5, 'Vendedor Uno'] }],
        }));
      }
      if (model === 'crm.team' && execMethod === 'search_read') {
        return Promise.resolve(json({
          result: [{ id: 1, name: 'Sales', user_id: [7, 'Líder Equipo'] }],
        }));
      }
      if (model === 'crm.lead' && execMethod === 'search') {
        return Promise.resolve(json({ result: [] })); // sin leads previos por referencia
      }
      if (model === 'crm.lead' && execMethod === 'create') {
        lastLead.value = execArgs[0];
        return Promise.resolve(json({ result: 9999 }));
      }
      if (model === 'crm.lead' && execMethod === 'message_post') {
        return Promise.resolve(json({ result: true }));
      }
      if (model === 'crm.tag') {
        return execMethod === 'search'
          ? Promise.resolve(json({ result: [7] }))
          : Promise.resolve(json({ result: 7 }));
      }
      if (model === 'ir.model.data' && execMethod === 'search_read') {
        return Promise.resolve(json({ result: [{ res_id: 4 }] }));
      }
      if (model === 'ir.model' && execMethod === 'search_read') {
        return Promise.resolve(json({ result: [{ id: 421 }] }));
      }
      if (model === 'mail.activity' && execMethod === 'create') {
        return Promise.resolve(json({ result: 500 }));
      }
      if (model === 'res.users' && execMethod === 'read') {
        return Promise.resolve(json({
          result: [{ name: 'Vendedor', partner_id: [10, 'Vendedor'], email: 'v@example.com' }],
        }));
      }
      return Promise.resolve(json({ result: false }));
    }
    return Promise.resolve(json({ result: false }));
  }

  return originalFetch(url, options);
};

function json(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

// Evita advertencias por el import de `mock` sin uso en algunos runners.
void mock;
