#!/usr/bin/env node
/**
 * voice-chunking.test.mjs: pins the map-reduce chunking that keeps transcript summarizing inside
 * the CANONICAL Ollama window. $0: no model, no network.
 *
 * WHY: on 2026-08-16 the machine moved to qwen3.8:27b-q8_0. Voice's num_ctx-40960 escalation went
 * from "costs a reload" to "does not fit at all" (35.5 GiB predicted vs ~38 GiB free), so Ollama
 * refused the load, the client aborted at 5 minutes, and every recording long enough to escalate
 * stopped being summarized. Short ones kept working, so nothing looked broken for four days.
 * Chunking replaces that escalation. The invariant these tests defend: EVERY request the
 * summarizer makes fits the canonical window, and NO transcript content is ever dropped to make
 * it fit.
 *
 * Run: node test/voice-chunking.test.mjs
 */
import { bodyBudgetTokens, chunkText, buildChunkPrompt } from '../lib/voice-chunking.js';
import { contextFor, estimateTokens, ESTIMATE_SLACK } from '../lib/ollama-context.js';
import { generate } from '../lib/guarded-generate.js';

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};
const section = (s) => console.log(`\n-- ${s} ${'-'.repeat(Math.max(0, 74 - s.length))}`);

// Strip whitespace: chunking is allowed to normalise separators, never to drop content.
const dense = (s) => String(s).replace(/\s+/g, '');

// An invented transcript shaped like a real one: paragraphs, sentences, numbers, a made-up name.
// Sized in CHARS so fixtures match real recordings (the 2026-08-20 failure was 32,067 chars).
const makeTranscriptOfChars = (targetChars) => {
  let out = '', i = 0;
  while (out.length < targetChars) {
    out += `${out ? '\n\n' : ''}Speaker ${i % 3}: point number ${i} about the rate of ${1000 + i} zorbs. ` +
      `We agreed that Ari Doe would follow up on item ${i}. There was some disagreement about timing.`;
    i++;
  }
  return out;
};
const makeTranscript = (paras) =>
  Array.from({ length: paras }, (_, i) =>
    `Speaker ${i % 3}: point number ${i} about the rate of ${1000 + i} zorbs. ` +
    `We agreed that Ari Doe would follow up on item ${i}. There was some disagreement about timing.`,
  ).join('\n\n');

// -- 0. the harness proves itself before any verdict counts
section('the detectors work (planted failures must be caught)');
{
  // a chunker that silently drops its tail: the exact failure mode we must never ship
  const dropping = (text, budget) => chunkText(text, budget).slice(0, -1);
  const text = makeTranscript(60);
  const good = chunkText(text, 400);
  const bad = dropping(text, 400);
  t('content-preservation check PASSES on the real chunker',
    dense(good.join('')) === dense(text), true);
  t('content-preservation check CATCHES a dropping chunker',
    dense(bad.join('')) === dense(text), false);

  // a chunker that ignores the budget
  const oversized = [text];
  const within = (pieces, budget) => pieces.every((p) => p.length <= Math.max(1000, budget * 4));
  t('budget check PASSES on the real chunker', within(good, 400), true);
  t('budget check CATCHES an over-budget chunker', within(oversized, 400), false);
}

// -- 1. chunkText never loses content
section('chunkText never drops content');
for (const paras of [1, 5, 40, 200]) {
  const text = makeTranscript(paras);
  const pieces = chunkText(text, 400);
  t(`${paras} paragraphs: every character preserved`, dense(pieces.join('')), dense(text));
}
t('empty input yields no chunks', chunkText('', 400), []);
t('whitespace-only input yields no chunks', chunkText('   \n\n  ', 400), []);

// -- 2. chunkText respects the budget
section('chunkText respects the budget');
{
  const text = makeTranscript(200);
  for (const budget of [300, 800, 2000]) {
    const pieces = chunkText(text, budget);
    const maxChars = Math.max(1000, budget * 4);
    t(`budget ${budget}: no piece exceeds its char ceiling`,
      pieces.every((p) => p.length <= maxChars), true);
    t(`budget ${budget}: every piece is non-empty`, pieces.every((p) => p.length > 0), true);
  }
  // a short transcript is a single chunk: chunking must not fire needlessly
  t('a short transcript stays one chunk', chunkText(makeTranscript(2), 4000).length, 1);
}

// -- 3. chunks open on clean boundaries
section('chunks open on clean boundaries, never mid-word');
{
  const pieces = chunkText(makeTranscript(200), 500);
  t('more than one chunk was produced', pieces.length > 1, true);
  t('no chunk starts with whitespace', pieces.every((p) => p === p.trimStart()), true);
  t('no chunk ends with whitespace', pieces.every((p) => p === p.trimEnd()), true);
}

section('a tiny trailing section is folded back, not left as its own model call');
{
  // 3 sections' worth plus a sliver: without the merge this splits 4 ways and wastes a call.
  const text = makeTranscriptOfChars(51798);
  const naive = chunkText(text, 4317);                                  // hard == preferred
  const merged = chunkText(text, 4317, { hardMaxTokens: 11702 });        // real ceiling is larger
  t('without headroom the runt survives', naive.length, 4);
  t('the runt is absorbed when the hard window allows', merged.length, 3);
  t('absorbing the runt loses no content', dense(merged.join('')), dense(text));
  t('the merged section still fits the hard ceiling',
    merged.every((p) => p.length <= 11702 * 4), true);
}

// -- 4. a pathological run-on still terminates
section('pathological input terminates instead of looping');
{
  const runOn = 'a'.repeat(50000); // no spaces, no sentences, no paragraphs
  const pieces = chunkText(runOn, 400);
  t('run-on text is still split', pieces.length > 1, true);
  t('run-on text loses nothing', dense(pieces.join('')), dense(runOn));
}

// -- 5. the budget arithmetic
section('bodyBudgetTokens arithmetic');
{
  const canonical = 16384, slack = ESTIMATE_SLACK;
  // The default model is the q4 build 'qwen3.8:27b' (since 2026-08-20); 'qwen3.8:27b-q8_0' is
  // the accuracy rollback and shares this window, so a rollback never changes the arithmetic below.
  t('canonical for the default model is 16384', contextFor('qwen3.8:27b'), 16384);
  t('the sanctioned rollback build shares that window', contextFor('qwen3.8:27b-q8_0'), 16384);
  // the window must hold prompt AND completion: 16384/1.1 = 14894, minus 8192 completion,
  // minus scaffolding. This is why a 55-minute (~8,000 token) transcript cannot go in whole.
  t('a full-schema call leaves ~5k tokens for the transcript',
    bodyBudgetTokens({ canonical, slack, numPredict: 8192, overheadTokens: 1700 }), 5002);
  t('a compact digest call leaves far more room',
    bodyBudgetTokens({ canonical, slack, numPredict: 1536, overheadTokens: 1700 }) > 11000, true);
  t('an impossible reservation reports a negative budget, it does not clamp',
    bodyBudgetTokens({ canonical, slack, numPredict: 14000, overheadTokens: 2000 }) < 0, true);
}

// -- 6. THE invariant: every chunk request fits, and detail is preserved
section('every chunk request fits the canonical window');
{
  const canonical = contextFor('qwen3.8:27b');   // the default (q4); the q8_0 rollback shares it
  const CHUNK_NUM_PREDICT = 1536; // the section-digest call's num_predict
  // Measured from the real 2026-08-20 failure: the run logged ~9,672 prompt tokens for a
  // 32,067-char transcript, so the fixed preamble, the schema and the grounding cost ~1,656 tokens.
  const OVERHEAD = 1656;
  const budget = (numPredict) =>
    bodyBudgetTokens({ canonical, slack: ESTIMATE_SLACK, numPredict, overheadTokens: OVERHEAD });
  const finalBudget = budget(8192);
  const chunkBudget = budget(CHUNK_NUM_PREDICT);

  t('the full-schema call leaves ~5,046 tokens for the body', finalBudget, 5046);
  t('a section call leaves ~11,702 tokens', chunkBudget, 11702);

  // The exact 55-minute recording that failed on 2026-08-20: 32,067 chars.
  const realWorld = makeTranscriptOfChars(32067);
  const tokens = estimateTokens(realWorld);
  t('the 55-minute case is too big for one full-schema call', tokens > finalBudget, true);

  // Sizing must prefer DETAIL: split into as many sections as the final call can hold, not the
  // fewest that fit. Splitting at chunkBudget would yield ONE digest for the whole meeting.
  t('splitting at the coarse budget would collapse it to a single section',
    chunkText(realWorld, chunkBudget).length, 1);

  const affordable = Math.max(1, Math.floor(finalBudget / CHUNK_NUM_PREDICT));
  const sizeTarget = Math.min(chunkBudget, Math.max(1, Math.ceil(tokens / affordable)));
  const pieces = chunkText(realWorld, sizeTarget, { hardMaxTokens: chunkBudget });
  t('the final call can afford 3 digests', affordable, 3);
  t('sizing splits it into exactly that many sections', pieces.length, affordable);
  t('no content is lost by the detail-preserving split', dense(pieces.join('')), dense(realWorld));

  const overflow = pieces.filter((p) => {
    const needed = estimateTokens(buildChunkPrompt(p, 1, pieces.length)) + CHUNK_NUM_PREDICT;
    return Math.ceil(needed * ESTIMATE_SLACK) > canonical;
  });
  t('NO section request exceeds the canonical window', overflow.length, 0);

  // worst case: every digest emits its full num_predict and must still fit the final call
  t('worst-case digests fit the final summarizing call',
    pieces.length * CHUNK_NUM_PREDICT <= finalBudget, true);

  // A much longer meeting must still bound every SECTION request; the digests will not fit the
  // final call in one pass, and that is exactly when the summarizer folds again (digests of digests).
  const huge = makeTranscriptOfChars(150000);
  const hugeTarget = Math.min(chunkBudget, Math.ceil(estimateTokens(huge) / affordable));
  const hugePieces = chunkText(huge, hugeTarget, { hardMaxTokens: chunkBudget });
  const hugeOverflow = hugePieces.filter((p) => {
    const needed = estimateTokens(buildChunkPrompt(p, 1, hugePieces.length)) + CHUNK_NUM_PREDICT;
    return Math.ceil(needed * ESTIMATE_SLACK) > canonical;
  });
  t('a 150k-char meeting still bounds every section request', hugeOverflow.length, 0);
  t('a 150k-char meeting loses no content', dense(hugePieces.join('')), dense(huge));
  t('its digests overflow one pass, so a second fold is required',
    hugePieces.length * CHUNK_NUM_PREDICT > finalBudget, true);
}

// -- the guarded request is well-formed (stubbed fetch: no model, no network) --
// The 2026-08-20 regression this section pins: a crash inside a summarizer's request builder
// shipped while every static check passed, because no check ever EXECUTED the function. Import
// the real module with a stubbed global fetch and prove a call travels all the way to a request,
// that the request carries the canonical window, and that an oversized prompt never leaves.
section('guarded request construction (stubbed fetch)');
{
  const HOST = 'http://localhost:11434';
  const MODEL = 'qwen3.8:27b';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ response: 'stub-ok' }) };
  };
  try {
    const r1 = await generate(HOST, { model: MODEL, prompt: 'hello there', wantJson: false });
    t('a guarded call reaches the network (no throw before the request)', calls.length, 1);
    t('the request goes to /api/generate', calls[0].url, `${HOST}/api/generate`);
    t('the response is returned', r1.raw, 'stub-ok');
    t('the request asks for the CANONICAL window', calls[0].body.options.num_ctx, contextFor(calls[0].body.model));
    t('wantJson:false omits format', 'format' in calls[0].body, false);
    t('keep_alive default is 5 idle minutes', calls[0].body.keep_alive, '5m');
    await generate(HOST, { model: MODEL, prompt: 'hello again' });
    t('the default call requests JSON output', calls[1].body.format, 'json');
    let overflowThrew = false;
    try { await generate(HOST, { model: MODEL, prompt: 'x '.repeat(120000) }); } catch { overflowThrew = true; }
    t('an oversized prompt THROWS instead of truncating silently', overflowThrew, true);
    t('...and never reaches the network', calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
