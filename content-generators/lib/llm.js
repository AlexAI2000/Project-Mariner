// Shared OpenRouter LLM call utility for content generators.
// All generators use this for consistent API access.
// Implements a full fallback cascade: for each model, try all 4 API keys.
// If all keys fail for a model, move to the next model.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Default model for content generation — can be overridden via CONTENT_GEN_MODEL env var.
const DEFAULT_MODEL = 'qwen/qwen3-235b-a22b';

// Fallback model list (raw OpenRouter model IDs, in priority order).
// Primary model is tried first, then these in sequence.
const FALLBACK_MODELS = [
  'openrouter/free',
  'nqwen/qwen3-next-80b-a3b-instruct:free',
  'sourceful/riverflow-v2-pro',
  'sourceful/riverflow-v2-fast',
  'stepfun/step-3.5-flash:free',
  'arcee-ai/trinity-large-preview:free',
  'liquid/lfm-2.5-1.2b-thinking:free',
  'bytedance-seed/seedream-4.5',
];

function collectApiKeys() {
  // Collect all configured API keys, deduplicating.
  const seen = new Set();
  const keys = [];
  const add = (k) => {
    if (!k) return;
    const trimmed = k.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    keys.push(trimmed);
  };

  // From comma/space/semicolon-separated OPENROUTER_API_KEYS list.
  const list = process.env.OPENROUTER_API_KEYS;
  if (list) {
    for (const k of list.split(/[\s,;]+/)) add(k);
  }
  // Primary key.
  add(process.env.OPENROUTER_API_KEY);

  return keys;
}

async function tryCall(apiKey, model, systemPrompt, userPrompt, maxTokens) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://openclaw-mrdz',
      'X-Title': 'OpenClaw Content Generator',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter returned empty content: ${JSON.stringify(data)}`);

  try {
    return JSON.parse(text);
  } catch {
    const stripped = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(stripped);
  }
}

function isRetryableError(err) {
  const msg = err?.message?.toLowerCase() ?? '';
  return (
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('resource exhausted') ||
    msg.includes('too many requests') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('model not found') ||
    msg.includes('model_not_found') ||
    msg.includes('404') ||
    msg.includes('no endpoints')
  );
}

export async function callLLM(systemPrompt, userPrompt, maxTokens = 1200) {
  const apiKeys = collectApiKeys();
  if (apiKeys.length === 0) {
    throw new Error('No OpenRouter API keys configured (set OPENROUTER_API_KEY or OPENROUTER_API_KEYS).');
  }

  const primaryModel = process.env.CONTENT_GEN_MODEL || DEFAULT_MODEL;
  const models = [primaryModel, ...FALLBACK_MODELS];

  let lastError;

  for (const model of models) {
    for (const apiKey of apiKeys) {
      try {
        return await tryCall(apiKey, model, systemPrompt, userPrompt, maxTokens);
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) {
          // Non-retryable error (e.g. bad JSON response) — skip remaining keys for this model.
          break;
        }
        // Retryable — try next key for this model.
      }
    }
    // All keys exhausted for this model — try next model.
  }

  throw lastError ?? new Error('All OpenRouter models and API keys exhausted.');
}
