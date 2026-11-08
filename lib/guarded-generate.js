/**
 * guarded-generate.js: a /api/generate call that always asks for the canonical window and
 * refuses an oversized prompt instead of letting Ollama truncate it.
 *
 * WHY: Ollama truncates input that does not fit `num_ctx` SILENTLY. The model then answers from
 * the part it kept and the reply reads as confident as a correct one. So the check happens here,
 * before the request is built: if prompt + completion (with estimator slack) do not fit the
 * model's canonical window, this throws and nothing reaches the network. The fix for a big input
 * is to chunk it (lib/voice-chunking.js), never to grow the window.
 *
 * On 2026-08-20 a crash inside the request builder of a transcript summarizer shipped while every
 * static check passed, because no test ever EXECUTED the function. The tests for this file import
 * it with a stubbed global fetch and prove a call travels all the way to a request.
 */
import { contextFor, estimateTokens, ESTIMATE_SLACK } from './ollama-context.js';

/** Completion tokens reserved when the caller does not say. */
export const DEFAULT_NUM_PREDICT = 1024;
/** How long Ollama keeps the runner loaded after the last request. */
export const DEFAULT_KEEP_ALIVE = '5m';

/**
 * Does this prompt plus its completion fit the model's canonical window?
 * Sized the same way contextForTokens() sizes: (estimate + num_predict) * slack.
 */
export function requestFits(model, prompt, numPredict = DEFAULT_NUM_PREDICT) {
  const window = contextFor(model);
  const needed = Math.ceil((estimateTokens(prompt) + numPredict) * ESTIMATE_SLACK);
  return { needed, window, fits: needed <= window };
}

/**
 * Build the /api/generate body. Throws when the request would not fit.
 *
 * @param {object} a
 * @param {string} a.model
 * @param {string} a.prompt
 * @param {number} [a.numPredict]  completion tokens to reserve
 * @param {boolean} [a.wantJson=true] ask Ollama for JSON output
 * @param {string} [a.keepAlive='5m']
 * @param {number} [a.temperature]
 */
export function buildGenerateRequest({
  model, prompt, numPredict = DEFAULT_NUM_PREDICT, wantJson = true,
  keepAlive = DEFAULT_KEEP_ALIVE, temperature,
}) {
  if (!model || typeof model !== 'string') throw new Error('buildGenerateRequest: model must be a string');
  const { needed, window, fits } = requestFits(model, prompt, numPredict);
  if (!fits) {
    throw new Error(
      `prompt needs ~${needed} tokens (prompt + num_predict, with estimator slack) but ${model} ` +
      `has a ${window}-token canonical window. Ollama would truncate it silently. Split the input ` +
      `(lib/voice-chunking.js) instead of growing the window.`);
  }
  const body = {
    model,
    prompt: String(prompt),
    stream: false,
    keep_alive: keepAlive,
    options: { num_ctx: contextFor(model), num_predict: numPredict },
  };
  if (temperature !== undefined) body.options.temperature = temperature;
  if (wantJson) body.format = 'json';
  return body;
}

/**
 * Send one guarded request. Returns { raw, body } where raw is Ollama's `response` text.
 *
 * @param {string} host e.g. 'http://localhost:11434'
 * @param {object} opts the same options as buildGenerateRequest()
 */
export async function generate(host, opts) {
  const body = buildGenerateRequest(opts);
  const res = await fetch(`${String(host).replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/generate returned ${res.status}`);
  const json = await res.json();
  return { raw: json.response, body };
}
