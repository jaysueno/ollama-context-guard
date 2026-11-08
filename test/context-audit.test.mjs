#!/usr/bin/env node
/**
 * context-audit.test.mjs: runs scripts/context-audit.sh against a stub Ollama.
 *
 * A tiny HTTP server on localhost answers /api/ps with whatever runners a case needs, and each
 * thrash case writes its own server log into a temp folder with timestamps relative to now. The
 * server is closed and the temp folder removed before the process exits. No model, no real
 * Ollama. Needs bash, curl and python3, like the script itself.
 *
 * Usage: node test/context-audit.test.mjs
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const section = (s) => console.log(`\n-- ${s} ${'-'.repeat(Math.max(0, 72 - s.length))}`);

const SCRIPT = fileURLToPath(new URL('../scripts/context-audit.sh', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'ctx-audit-test-'));

let psModels = [];
const server = createServer((req, res) => {
  if (req.url === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: psModels }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const listen = (srv) => new Promise((r) => srv.listen(0, 'localhost', () => r(srv.address().port)));
const run = (env) => new Promise((resolve) => {
  execFile('bash', [SCRIPT], { env: { PATH: process.env.PATH, ...env }, timeout: 30000 }, (err, stdout) => {
    const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
    resolve({ code, out: String(stdout).trim() });
  });
});

// An Ollama-style server log. Each entry is [minutes ago, blob]. The blob name is built at run
// time so no long hex run sits in this file.
const BLOB_A = 'ab12cd34'.repeat(8);
const BLOB_B = 'ef56ab78'.repeat(8);
const writeLog = (name, entries) => {
  const lines = [];
  for (const [minsAgo, blob] of entries) {
    const ts = new Date(Date.now() - minsAgo * 60000).toISOString().replace('Z', '+00:00');
    lines.push(`time=${ts} level=INFO source=server.go:400 msg="starting runner"`);
    lines.push(`time=${ts} level=INFO source=server.go:405 msg="loading model via llama-server" path=/models/blobs/sha256-${blob}`);
  }
  const p = join(TMP, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

try {
  const port = await listen(server);
  const OLLAMA_URL = `http://localhost:${port}`;

  section('context drift from /api/ps');
  psModels = [{ model: 'qwen3.6:27b', context_length: 16384 }];
  t('a runner at its canonical window is OK (exit 0)', await run({ OLLAMA_URL }), { code: 0, out: 'ctx-audit: OK' });

  psModels = [{ model: 'qwen3.6:27b', context_length: 40960 }];
  t('the sanctioned escalation is not flagged', (await run({ OLLAMA_URL })).code, 0);

  psModels = [{ model: 'qwen3.6:27b', context_length: 8192 }];
  t('a runner at a non-sanctioned window is flagged (exit 1) with actual, canonical and escalation',
    await run({ OLLAMA_URL }),
    { code: 1, out: 'ctx-audit: context drift: qwen3.6:27b loaded at 8192 (canonical 16384, escalation 40960).' });

  psModels = [{ model: 'qwen3.6:27b', context_length: 262144 }];
  t('the 262144 ad-hoc load is flagged', (await run({ OLLAMA_URL })).code, 1);

  psModels = [{ model: 'lane-a', context_length: 65536 }, { name: 'nomic-embed-text:latest', context_length: 2048 }];
  t('a lane tag at its own window and an embedding model are OK', (await run({ OLLAMA_URL })).code, 0);

  psModels = [{ model: 'some-future-model:1b', context_length: 4096 }];
  t('an unknown model off the default window is flagged against the default',
    (await run({ OLLAMA_URL })).out, 'ctx-audit: context drift: some-future-model:1b loaded at 4096 (canonical 8192).');

  psModels = [];
  t('nothing loaded is OK', (await run({ OLLAMA_URL })).code, 0);

  section('reload thrash from the server log');
  psModels = [{ model: 'qwen3.6:27b', context_length: 16384 }];
  const five = writeLog('five.log', [[1, BLOB_A], [3, BLOB_A], [5, BLOB_A], [7, BLOB_A], [9, BLOB_A], [2, BLOB_B]]);
  t('five loads of one blob in 15 minutes is thrash (exit 1)', await run({ OLLAMA_URL, OLLAMA_LOG: five }),
    { code: 1, out: 'ctx-audit: reload thrash: blob ab12cd34 loaded 5x in 15m.' });

  const four = writeLog('four.log', [[1, BLOB_A], [3, BLOB_A], [5, BLOB_A], [7, BLOB_A]]);
  t('four loads is not thrash (the limit is more than four)', (await run({ OLLAMA_URL, OLLAMA_LOG: four })).code, 0);

  const old = writeLog('old.log', [[20, BLOB_A], [25, BLOB_A], [30, BLOB_A], [35, BLOB_A], [40, BLOB_A]]);
  t('loads older than the window are not counted', (await run({ OLLAMA_URL, OLLAMA_LOG: old })).code, 0);
  t('a wider window counts them', (await run({ OLLAMA_URL, OLLAMA_LOG: old, THRASH_WINDOW_MIN: '60' })).code, 1);

  psModels = [{ model: 'qwen3.6:27b', context_length: 8192 }];
  t('drift and thrash are reported together', (await run({ OLLAMA_URL, OLLAMA_LOG: five })).out,
    'ctx-audit: context drift: qwen3.6:27b loaded at 8192 (canonical 16384, escalation 40960). reload thrash: blob ab12cd34 loaded 5x in 15m.');

  section('skips, never false alarms');
  psModels = [{ model: 'qwen3.6:27b', context_length: 16384 }];
  t('a log path that does not exist skips the thrash check', (await run({ OLLAMA_URL, OLLAMA_LOG: join(TMP, 'missing.log') })).code, 0);
  t('a missing config file skips with exit 0', (await run({ OLLAMA_URL, CONTEXT_CONFIG: join(TMP, 'none.json') })).out.startsWith('ctx-audit: SKIP'), true);

  const closed = createServer();
  const deadPort = await listen(closed);
  await new Promise((r) => closed.close(r));
  t('an unreachable /api/ps skips with exit 0', await run({ OLLAMA_URL: `http://localhost:${deadPort}` }),
    { code: 0, out: 'ctx-audit: SKIP (/api/ps unreachable)' });
} finally {
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
