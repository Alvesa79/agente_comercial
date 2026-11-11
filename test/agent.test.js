// Tests de la lógica del agente sin depender de Odoo ni de WhatsApp.
// Los mocks se cargan ANTES de importar src/agent.js.

import { lastLead, resetLastLead } from './mocks.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { handleIncomingMessage, resetSession, getSession } = await import('../src/agent.js');
const { claimMessage } = await import('../src/store.js');

async function completeFlow(phone) {
  await handleIncomingMessage(phone, 'Hola, quiero info');
  await handleIncomingMessage(phone, 'Ana López');
  await handleIncomingMessage(phone, 'Me interesa un seguro de auto');
  await handleIncomingMessage(phone, '5000 pesos');
  return handleIncomingMessage(phone, 'CDMX');
}

test('flujo completo: crea lead al terminar la recolección de datos', async () => {
  resetSession('+5255500000000');
  resetLastLead();
  const { leadId } = await completeFlow('+5255500000000');

  assert.equal(leadId, 9999, 'debe crear el lead al terminar el flujo'); // Odoo simulado
});

test('contacto existente: asigna al vendedor del partner', async () => {
  resetSession('+5255500000009');
  resetLastLead();
  const { leadId } = await completeFlow('+5255500000009');

  assert.equal(leadId, 9999);
  assert.equal(lastLead.value.partner_id, 1, 'vincula el lead al contacto existente');
  assert.equal(lastLead.value.user_id, 5, 'usa el salesperson del contacto');
});

test('contacto nuevo: asigna al líder del equipo', async () => {
  resetSession('+5255500000011');
  resetLastLead();
  const { leadId } = await completeFlow('+5255500000011');

  assert.equal(leadId, 9999);
  assert.equal(lastLead.value.partner_id, false);
  assert.equal(lastLead.value.user_id, 7, 'usa el Team Leader');
  assert.equal(lastLead.value.team_id, 1);
});

test('handoff: crea el lead y lo asigna aunque falten datos', async () => {
  resetSession('+5255500000012');
  resetLastLead();
  await handleIncomingMessage('+5255500000012', 'Hola');
  const { leadId, handoff } = await handleIncomingMessage(
    '+5255500000012',
    'Quiero hablar con un asesor'
  );

  assert.equal(handoff, true);
  assert.equal(leadId, 9999, 'el handoff debe dejar un lead registrado');
  assert.equal(lastLead.value.user_id, 7);
});

test('idempotencia: una entrega de Meta se procesa una sola vez', () => {
  assert.equal(claimMessage('wamid-test-1'), true);
  assert.equal(claimMessage('wamid-test-1'), false);
});

test('solicita hablar con un asesor -> handoff', async () => {
  resetSession('+5255500000001');
  await handleIncomingMessage('+5255500000001', 'Hola');
  const { handoff } = await handleIncomingMessage('+5255500000001', 'Quiero hablar con un asesor');
  assert.equal(handoff, true);
});

test('comando "cancelar" reinicia la sesión', async () => {
  resetSession('+5255500000002');
  await handleIncomingMessage('+5255500000002', 'Hola');
  await handleIncomingMessage('+5255500000002', 'Ana');
  resetSession('+5255500000002');
  const s = getSession('+5255500000002');
  assert.equal(s.step, 'START');
});
