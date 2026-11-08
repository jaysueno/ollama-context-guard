/**
 * ollama-context.js: THE canonical context window per model on a shared Ollama server.
 *
 * WHY THIS EXISTS (2026-07-28 incident, about 40 minutes of dead receipt reading):
 * Ollama keeps ONE runner per model, and that runner's context is fixed at LOAD time. When a
 * second caller asks for the SAME model with a DIFFERENT `num_ctx`, Ollama tears the runner down
 * and reloads it: ~19 GB for qwen3.6:27b. Two callers with different windows do not take turns,
 * they THRASH: each load evicts the other's, and a caller whose load is evicted mid-flight gets
 * `client connection closed before llama-server finished loading, aborting load` and hangs until
 * its own timeout. The receipt reader used a literal 8192; a transcript summarizer used a literal
 * 40960 with a 5-attempt retry loop. Receipt reading died for about 40 minutes while every
 * health probe stayed green.
 *
 * THE SECOND, SUBTLER FACT: `num_ctx` IS A REQUEST, NOT A GUARANTEE.
 * Ollama 0.30.7's scheduler re-fits the context to FREE SYSTEM MEMORY at load time and logs the
 * decision as `predicted_num_ctx=N ... system_free=X`. Measured on a 64 GB Mac Mini, 2026-07-28:
 *   request 40960 (needs 20.3 GiB) -> GRANTED at system_free 31.1-48.5 GiB
 *                                  -> DOWNSIZED to 16384 at system_free 29.1-29.3 GiB
 * The machine oscillates 27-32 GiB free, so 40960 straddles the boundary and gets evicted and
 * re-fitted repeatedly. A/B over 5 real receipts, identical compute at both windows
 * (prompt 2962tok/25.6s, out 463tok/37.3s), but:
 *   num_ctx  8192 (17.4 GiB): load=0.3s on every call,  63.4s avg; the runner never moved
 *   num_ctx 40960 (20.3 GiB): load=95.5s and 141.9s,   110.7s avg; evicted twice in 5 calls
 * So the canonical window is NOT "the biggest anyone needs". It is the biggest that RELIABLY
 * FITS. 16384 needs 17.8 GiB and was granted at system_free 29.1 GiB: inside the boundary.
 *
 * THE RULE: one model = one context window, for every caller, in every language. Never pass a
 * literal `num_ctx` at a call site; `test/discipline.test.mjs` fails the build if you do. The
 * single exception is a LENGTH-GATED escalation (below), for input that genuinely does not fit
 * and would otherwise be silently truncated.
 */
import { readFileSync } from 'node:fs';

// The table lives in config/ollama-context.json so callers in other languages read the SAME
// source: one model = one context in every language, not two tables that drift apart.
const _cfg = JSON.parse(
  readFileSync(new URL('../config/ollama-context.json', import.meta.url), 'utf8'),
);

/**
 * Canonical context window per model: what EVERY caller uses by default.
 * qwen3.6:27b = 16384: the largest window that reliably fits the machine's free memory, so the
 * runner stays resident instead of being re-fitted. nomic's trained context is 2048.
 */
export const MODEL_CONTEXT = Object.freeze({ ..._cfg.models });

/**
 * The ONLY sanctioned larger window per model, and only via contextForTokens().
 * qwen3.6:27b = 40960 was for voice transcripts (177 measured: p50 1,495 tok, p90 8,919,
 * p99 23,271, max 30,238). The window holds prompt AND completion. Requesting it costs a reload,
 * so it is gated on the input actually needing it, never on habit. No caller uses it today:
 * long transcripts are chunked instead (lib/voice-chunking.js).
 */
export const MODEL_ESCALATION = Object.freeze({ ..._cfg.escalation });

/** Models with no entry above fall back to this. Deliberately generous: an unlisted model
 *  getting a too-SMALL window truncates input silently, which is worse than costing RAM. */
export const DEFAULT_CONTEXT = _cfg.default;

/**
 * Safety multiplier applied to a TOKEN ESTIMATE, because `estimateTokens()` is a crude
 * ~4-chars/token approximation that can under-count (names, punctuation, code, non-English).
 * It is slack for the ESTIMATOR: not room for the prompt, and not room for the completion.
 * The caller owns that arithmetic and passes the complete figure; see contextForTokens().
 */
export const ESTIMATE_SLACK = _cfg.estimate_slack;

/**
 * The context a second, non-Ollama engine was launched with, from the same config file. NOT an
 * Ollama num_ctx: such an engine (for example a llama.cpp server) fixes its context at launch and
 * ignores any window in a request body. It lives here so "how much room does the local model
 * have" has ONE answer per backend, in one file, for every language.
 */
export const ENGINE_WINDOW = _cfg.engine_window;

const bare = (m) => (m.endsWith(':latest') ? m.slice(0, -':latest'.length) : m);
const lookup = (table, model) =>
  table[model] ?? table[bare(model)] ?? table[`${bare(model)}:latest`] ?? null;

/**
 * The context window a caller must use for `model`.
 * Pass this to Ollama as `options.num_ctx`, never a literal.
 *
 * @param {string} model exact Ollama model tag, e.g. 'qwen3.6:27b'
 * @returns {number} the canonical num_ctx
 */
export function contextFor(model) {
  if (!model || typeof model !== 'string') throw new Error(`contextFor: model must be a string, got ${typeof model}`);
  return lookup(MODEL_CONTEXT, model) ?? DEFAULT_CONTEXT;
}

/**
 * Which engine is serving, read from the env: LOCAL_LLM_BACKEND = "ollama" (the default),
 * "engine" (a second engine with a fixed window), or "disabled". A caller that already resolved
 * the backend (with its own per-path pins) passes it in as `resolvedBackend`, so the two cannot
 * drift; the env read here is the fallback for direct callers.
 */
function backendOf(env, resolvedBackend) {
  if (resolvedBackend) return String(resolvedBackend).trim().toLowerCase();
  const raw = env?.LOCAL_LLM_BACKEND;
  return (raw !== undefined && raw !== null && String(raw).trim() !== '')
    ? String(raw).trim().toLowerCase()
    : 'ollama';
}

/**
 * A "big model" is one this table knows about that is NOT an embedding model. Embeddings
 * (nomic-embed-text, 0.37 GB) stay on Ollama in every setup and must never be blocked; the
 * 17-30 GB generation models are the ones that cannot share a 64 GB machine with a second
 * engine holding ~44 GiB. A model this table has never heard of is not treated as big: the
 * table is the contract, and guessing about an unknown tag would block legitimate new callers.
 */
export function isBigOllamaModel(model) {
  if (!model || typeof model !== 'string') return false;
  if (/embed/i.test(model)) return false;
  return lookup(MODEL_CONTEXT, model) !== null;
}

/**
 * Refuse to load a big Ollama model while a different engine owns the GPU.
 *
 * WHY (two incidents on 2026-09-15): at 12:00:12 and again at 13:00:09 something asked Ollama
 * for qwen3.6:27b while a second engine held ~44 GiB. 17 + 44 does not fit 64, so the engine's
 * Metal allocations failed, it answered 500, then crash-looped and was down for five minutes,
 * taking receipt reading and voice with it. Nothing in the code said no; the request was simply
 * made. This is the code saying no, at the last point before the request is built, with a
 * message that names the fix.
 *
 * @param {string} model             the Ollama tag about to be requested
 * @param {object} [env]             process.env
 * @param {string} [resolvedBackend] the backend the caller already resolved (pins included)
 * @throws {Error} when a big model is requested and the machine is not serving from Ollama
 */
export function assertOllamaAllowed(model, env = process.env, resolvedBackend = undefined) {
  const backend = backendOf(env, resolvedBackend);
  if (backend === 'ollama') return;
  if (!isBigOllamaModel(model)) return;
  throw new Error(
    `refusing to load Ollama model ${model} while LOCAL_LLM_BACKEND=${backend}: a 17-30 GB Ollama ` +
    `runner cannot share a 64 GB machine with the engine that is resident, and loading one ` +
    `crashed that engine twice on 2026-09-15. Send this call to the engine that IS loaded, or ` +
    `switch the machine back to Ollama first (LOCAL_LLM_BACKEND=ollama).`);
}

/**
 * How much room the local model has, for callers that PLAN around it (transcript chunking).
 * engine -> its launch-time window; Ollama -> the canonical per-model window.
 *
 * Not the same question as contextFor(): that one answers "what num_ctx do I put in this Ollama
 * request body", which is meaningless on an engine with a fixed window. A planner that asked
 * contextFor() there would split a transcript into 16k sections on a 65k server (measured on
 * 2026-09-15: three chunks where one would have done, each digest losing detail for nothing).
 */
export function windowFor(model, env = process.env, resolvedBackend = undefined) {
  return backendOf(env, resolvedBackend) === 'engine' ? ENGINE_WINDOW : contextFor(model);
}

/** Rough token estimate for English prose. Deliberately conservative (~4 chars/token). */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * The canonical window, OR the sanctioned escalation when the input genuinely will not fit.
 *
 * This is the ONE way a caller may exceed the canonical window, and it must be justified by
 * length, never "this job feels important". Escalating costs a full model reload on a machine
 * where 40960 straddles the memory-fit boundary, so it must stay rare.
 *
 * If the input exceeds even the escalation window, we still return the escalation and let the
 * CALLER decide (chunk, or accept truncation knowingly). This function never silently hides
 * the fact that input was too big. Callers should check `willTruncate()`.
 *
 * CONTRACT: `neededTokens` is the COMPLETE budget the request needs: prompt AND completion
 * (`num_predict`). The caller owns that arithmetic, because only the caller knows how much it
 * asked the model to generate. This function adds nothing except estimator slack; an earlier
 * version also added a "prompt reserve" here, which double-counted against callers that had
 * already included their prompt and pushed the voice escalation rate from 12% to 25%.
 *
 * @param {string} model
 * @param {number} neededTokens prompt + completion tokens the request needs
 * @returns {number} num_ctx to request
 */
export function contextForTokens(model, neededTokens) {
  const canonical = contextFor(model);
  if (budgetFor(neededTokens) <= canonical) return canonical;
  const escalated = lookup(MODEL_ESCALATION, model);
  return escalated && escalated > canonical ? escalated : canonical;
}

/** The estimate plus its slack: the number we actually size against. */
const budgetFor = (neededTokens) => Math.ceil(Number(neededTokens || 0) * ESTIMATE_SLACK);

/** True when `neededTokens` will not fit even the largest sanctioned window for `model`.
 *  Ollama truncates silently, so a caller that ignores this produces a confidently wrong answer. */
export function willTruncate(model, neededTokens) {
  return budgetFor(neededTokens) > contextForTokens(model, neededTokens);
}

/**
 * Read the LIVE loaded context from Ollama's /api/ps and report any model whose runner is loaded
 * at a context that is neither its canonical value nor its sanctioned escalation.
 *
 * This is the half of the guard that source code cannot provide. On 2026-07-28 two `-c 262144`
 * loads came from an ad-hoc script run off a laptop: code in no repo. Whatever the caller, the
 * drift shows up here. NOTE: because Ollama re-fits to free memory, a runner can land on a
 * non-canonical size with no caller at fault; that is still worth reporting, because it means
 * the box is under memory pressure and the runner is about to churn.
 *
 * @param {string} ollamaHost e.g. 'http://localhost:11434'
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<{ok: boolean, loaded: Array<{model: string, actual: number, expected: number, escalation: (number|null), ok: boolean}>}>}
 */
export async function auditLoadedContexts(ollamaHost, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let ps;
  try {
    const res = await fetch(`${String(ollamaHost).replace(/\/$/, '')}/api/ps`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`/api/ps returned ${res.status}`);
    ps = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const loaded = (ps.models || []).map((m) => {
    const name = m.model || m.name;
    const expected = contextFor(name);
    const escalation = lookup(MODEL_ESCALATION, name);
    const actual = m.context_length;
    return { model: name, actual, expected, escalation, ok: actual === expected || actual === escalation };
  });
  return { ok: loaded.every((m) => m.ok), loaded };
}
