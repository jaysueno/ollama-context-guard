#!/usr/bin/env node
/**
 * context.test.mjs: pins the canonical table, the length gate, the runtime audit and the
 * co-residency guard in lib/ollama-context.js. $0: no model, no network (fetch is stubbed).
 *
 * The static half of the guard (no literal num_ctx at a call site) lives in
 * test/discipline.test.mjs. This file pins the values and functions that half points callers at.
 *
 * Usage: node test/context.test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  MODEL_CONTEXT, MODEL_ESCALATION, DEFAULT_CONTEXT, ESTIMATE_SLACK, ENGINE_WINDOW,
  contextFor, contextForTokens, estimateTokens, willTruncate, auditLoadedContexts,
  windowFor, assertOllamaAllowed, isBigOllamaModel,
} from '../lib/ollama-context.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const section = (s) => console.log(`\n-- ${s} ${'-'.repeat(Math.max(0, 72 - s.length))}`);

const cfg = JSON.parse(readFileSync(new URL('../config/ollama-context.json', import.meta.url), 'utf8'));

// -- 1. THE TABLE -------------------------------------------------------------------------
section('the canonical table');
t('JS module and JSON agree on the model table', MODEL_CONTEXT, cfg.models);
t('JS module and JSON agree on the escalation table', MODEL_ESCALATION, cfg.escalation);
t('JS module and JSON agree on the default', DEFAULT_CONTEXT, cfg.default);
// 16384 is the largest window that RELIABLY FITS the machine's free memory (17.8 GiB predicted,
// granted at system_free 29.1 GiB). 40960 needs 20.3 GiB and only fits above ~31 GiB free, so
// as a *canonical* value it would be evicted and re-fitted repeatedly: measured, two reloads
// of 95.5s and 141.9s in five calls. Raising this is a deliberate, re-measured change.
t('qwen3.6:27b canonical is the measured-stable 16384', contextFor('qwen3.6:27b'), 16384);
t('qwen3.6:27b escalation is 40960', MODEL_ESCALATION['qwen3.6:27b'], 40960);
// qwen3.8:27b inherits the same measured-stable windows. qwen3.6 entries stay pinned because they
// are the rollback path, and so does qwen3.8:27b-q8_0, the accuracy rollback for the q4 default.
t('qwen3.8:27b (default) canonical is 16384', contextFor('qwen3.8:27b'), 16384);
t('qwen3.8:27b (default) escalation is 40960', MODEL_ESCALATION['qwen3.8:27b'], 40960);
t('qwen3.8:27b-q8_0 (rollback) canonical is 16384', contextFor('qwen3.8:27b-q8_0'), 16384);
t('qwen3.8:27b-q8_0 (rollback) escalation is 40960', MODEL_ESCALATION['qwen3.8:27b-q8_0'], 40960);
t('a lane tag resolves to its own window', contextFor('lane-a'), 65536);
t(':latest suffix resolves to the same window', contextFor('nomic-embed-text:latest'), contextFor('nomic-embed-text'));
t(':latest on a bare table key resolves too', contextFor('lane-b:latest'), contextFor('lane-b'));
t('unknown model falls back to the default', contextFor('some-future-model:1b'), DEFAULT_CONTEXT);
t('contextFor rejects a non-string', (() => { try { contextFor(null); return 'no throw'; } catch { return 'threw'; } })(), 'threw');

// EVERY caller of a given model must resolve to ONE window by default: that is the invariant.
// Both builds are listed because a rollback must not change the window under a caller.
t('all default callers resolve to one window', new Set(['qwen3.8:27b', 'qwen3.8:27b-q8_0'].map(contextFor)).size, 1);

// -- 2. THE LENGTH GATE -------------------------------------------------------------------
// Escalation is the ONE sanctioned way past the canonical window, and it must be earned by the
// input's actual size. An unconditional escalation is the 2026-07-28 bug wearing a helper's name.
// CONTRACT: callers pass the COMPLETE budget, prompt AND completion (num_predict). The module
// adds only estimator slack. An earlier version also added a flat "prompt reserve" here, which
// double-counted against callers that had already included their prompt and pushed the voice
// escalation rate from 12.4% to 24.9% of transcripts.
section('escalation is length-gated, not habitual');
const M = 'qwen3.8:27b';
const NP = 8192;                       // voice's num_predict: half the canonical window
const fits = Math.floor(16384 / ESTIMATE_SLACK);
t('slack is a ratio, not a flat add', ESTIMATE_SLACK > 1 && ESTIMATE_SLACK < 1.5, true);
t('a small input stays canonical', contextForTokens(M, 500), 16384);
t('p50 transcript (1,495 tok) + num_predict stays canonical', contextForTokens(M, 1495 + NP), 16384);
t('p99 transcript (23,271 tok) escalates', contextForTokens(M, 23271 + NP), 40960);
t('max observed transcript (30,238 tok) escalates', contextForTokens(M, 30238 + NP), 40960);
// the boundary, exactly: sized against estimate*slack, nothing else added
t('boundary: the largest budget that fits stays canonical', contextForTokens(M, fits), 16384);
t('boundary: one token over escalates', contextForTokens(M, fits + 1), 40960);
// a model with NO escalation entry must never invent one
t('a model without an escalation never exceeds canonical', contextForTokens('nomic-embed-text', 999999), 2048);
// Truncation must be REPORTED, never hidden. The largest transcript measured (30,238 tok) plus an
// 8192-token completion budget, with estimator slack, comes to 42,273, which does NOT fit even the
// 40960 escalation. willTruncate() fires on exactly those. That is the honest answer, not a bug:
// Ollama would truncate them silently and hand back a confidently incomplete summary. The fix for
// them is chunking (lib/voice-chunking.js), not a bigger number.
t('a mid-size transcript inside the escalation reports no truncation', willTruncate(M, 23271 + NP), false);
t('the LARGEST observed transcript is past the edge and is reported as truncation', willTruncate(M, 30238 + NP), true);
t('input far beyond the escalation reports truncation', willTruncate(M, 60000), true);
t('estimateTokens is ~4 chars/token', estimateTokens('x'.repeat(4000)), 1000);

// -- 3. THE RUNTIME AUDIT (JS) ------------------------------------------------------------
// Source-level discipline cannot see an ad-hoc script run off a laptop: on 2026-07-28 exactly
// that put two `-c 262144` loads on the shared machine. auditLoadedContexts is the half of the
// guard that watches the LIVE runner, so it must actually flag drift.
section('runtime audit flags live drift');
const realFetch = globalThis.fetch;
const stubPs = (models) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ models }) }); };
try {
  stubPs([{ model: 'qwen3.6:27b', context_length: 16384 }]);
  t('canonical load reports ok', (await auditLoadedContexts('http://x')).ok, true);

  // a legitimate long-input run holds the escalation: that must NOT page anyone
  stubPs([{ model: 'qwen3.6:27b', context_length: 40960 }]);
  t('the sanctioned escalation is not flagged', (await auditLoadedContexts('http://x')).ok, true);

  // 8192 is what the receipt reader used to hardcode: below canonical, so the runner got re-fitted
  stubPs([{ model: 'qwen3.6:27b', context_length: 8192 }]);
  const drift = await auditLoadedContexts('http://x');
  t('a runner loaded at a NON-sanctioned window is flagged', drift.ok, false);
  t('the flag names actual, expected and escalation',
    drift.loaded[0], { model: 'qwen3.6:27b', actual: 8192, expected: 16384, escalation: 40960, ok: false });

  // the exact shape of the 2026-07-28 laptop batch
  stubPs([{ model: 'qwen3.6:27b', context_length: 262144 }]);
  t('the 262144 ad-hoc load is flagged', (await auditLoadedContexts('http://x')).ok, false);

  // Ollama's own memory re-fit lands here: no caller at fault, still worth reporting
  stubPs([{ model: 'qwen3.6:27b', context_length: 5139 }]);
  t("Ollama's memory re-fit to an odd size is flagged", (await auditLoadedContexts('http://x')).ok, false);

  stubPs([]);
  t('nothing loaded is not an error', (await auditLoadedContexts('http://x')).ok, true);
} finally {
  globalThis.fetch = realFetch;
}

// -- 4. CO-RESIDENCY: a big Ollama model must never load beside a resident second engine --
// WHY (2026-09-15, twice): something asked Ollama for qwen3.6:27b at 12:00:12 and again at
// 13:00:09 while a second engine held ~44 GiB. 17 + 44 does not fit 64: the engine's Metal
// allocations failed, it answered 500, then crash-looped for five minutes. Nothing in the code
// said no. These assertions are the code saying no.
section('co-residency guard');
t('a table model is "big"', isBigOllamaModel('qwen3.6:27b'), true);
t('the default model is "big"', isBigOllamaModel('qwen3.8:27b'), true);
t('the q8 rollback is "big"', isBigOllamaModel('qwen3.8:27b-q8_0'), true);
t('every non-embedding model in the table is big',
  Object.keys(MODEL_CONTEXT).filter((m) => !/embed/i.test(m)).every(isBigOllamaModel), true);
t('an EMBEDDING model is never big', isBigOllamaModel('nomic-embed-text'), false);
t('an embedding model with :latest is never big', isBigOllamaModel('nomic-embed-text:latest'), false);
t('a model the table never heard of is not assumed big', isBigOllamaModel('some-future-model:1b'), false);
t('a non-string is not big', isBigOllamaModel(null), false);

const allowed = (m, env, resolved) => {
  try { assertOllamaAllowed(m, env, resolved); return 'allowed'; } catch { return 'refused'; }
};
t('machine on Ollama: a big model is allowed', allowed('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'ollama' }), 'allowed');
t('backend unset (= Ollama): a big model is allowed', allowed('qwen3.8:27b', {}), 'allowed');
t('machine on the second engine: a big model is REFUSED', allowed('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'engine' }), 'refused');
t('machine on the second engine: the 13:00 culprit is REFUSED', allowed('qwen3.6:27b', { LOCAL_LLM_BACKEND: 'engine' }), 'refused');
t('machine on the second engine: embeddings still allowed', allowed('nomic-embed-text', { LOCAL_LLM_BACKEND: 'engine' }), 'allowed');
t('backend disabled: a big model is REFUSED too', allowed('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'disabled' }), 'refused');
t('an explicit resolved backend wins over the env',
  allowed('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'ollama' }, 'engine'), 'refused');
t('the refusal names the model AND the way out', (() => {
  try { assertOllamaAllowed('qwen3.6:27b', { LOCAL_LLM_BACKEND: 'engine' }); return 'no throw'; }
  catch (e) {
    return /qwen3\.6:27b/.test(e.message) && /LOCAL_LLM_BACKEND=ollama/.test(e.message) ? 'named' : e.message;
  }
})(), 'named');

// -- 5. windowFor: the PLANNING window follows the serving engine -------------------------
// contextFor() answers "what num_ctx goes in an Ollama request body". On an engine whose context
// is fixed at launch, that question has no meaning. A planner that asked contextFor() there split
// a transcript into 16k sections on a 65k server (measured 2026-09-15).
section('windowFor follows the engine');
t('engine_window is in the config', ENGINE_WINDOW, 65536);
t('ollama (default): windowFor == contextFor', windowFor('qwen3.8:27b', {}), contextFor('qwen3.8:27b'));
t('ollama explicit: windowFor == contextFor',
  windowFor('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'ollama' }), contextFor('qwen3.8:27b'));
t('engine: windowFor is the server window', windowFor('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'engine' }), ENGINE_WINDOW);
t('engine: the window does not depend on the Ollama tag',
  windowFor('nomic-embed-text', { LOCAL_LLM_BACKEND: 'engine' }), ENGINE_WINDOW);
t('a resolved backend beats the env here too',
  windowFor('qwen3.8:27b', { LOCAL_LLM_BACKEND: 'ollama' }, 'engine'), ENGINE_WINDOW);
t('the config and the module agree on engine_window', ENGINE_WINDOW, cfg.engine_window);

// -- verdict ------------------------------------------------------------------------------
console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
