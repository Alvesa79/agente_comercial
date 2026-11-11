// Adaptador LLM opcional compatible con OpenAI Chat Completions
// (OpenAI, Azure OpenAI, OpenRouter, Ollama con /v1, etc.).

import { config, llmConfigured } from './config.js';

const SYSTEM_PROMPT = `Eres un asistente comercial. Del mensaje del cliente extrae JSON con:
  - "need": descripción breve de lo que busca (una frase)
  - "category": una de las categorías ["Seguros","Inmobiliaria","Automotriz","Educación","Servicios","General"]
Responde SOLO con el JSON, sin texto adicional.`;

// Extracción de categorías para cargarlas desde un array único
const CATEGORIES = ['Seguros', 'Inmobiliaria', 'Automotriz', 'Educación', 'Servicios', 'General'];

export async function classifyWithLlm(text) {
  if (!llmConfigured()) throw new Error('LLM no configurado');

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      max_tokens: 150,
    }),
  });

  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  try {
    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
    if (!CATEGORIES.includes(parsed.category)) parsed.category = 'General';
    return parsed;
  } catch {
    throw new Error(`Respuesta LLM no es JSON válido: ${content}`);
  }
}
