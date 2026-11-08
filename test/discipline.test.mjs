#!/usr/bin/env node
/**
 * discipline.test.mjs: the static guard for "one model = one context window".
 *
 * $0, no network, no model, a few seconds. Run it before any commit that touches an Ollama call
 * site. It reads callsites.json (next to package.json, or the file named by $CALLSITES) to learn
 * which folder to walk and which files are known call sites.
 *
 * WHY (2026-07-28, about 40 minutes of dead receipt reading): Ollama keeps ONE runner per model
 * and fixes its context at LOAD time. The receipt reader asked qwen3.6:27b for num_ctx 8192 while
 * a transcript summarizer asked the same model for 40960, so every call evicted the other's
 * ~19 GB runner. Ollama logged `client connection closed before llama-server finished loading,
 * aborting load`, returned 500 at exactly 5m0s (OLLAMA_LOAD_TIMEOUT), and a 499 at 4m44s where
 * the receipt client gave up. Nothing errored in the app; receipt capture just spun.
 *
 * Every assertion below pins an invariant whose silent failure re-opens that outage.
 * Read the failure message before "fixing" a test.
 *
 * Usage: node test/discipline.test.mjs
 *        CALLSITES=/path/to/your/callsites.json node test/discipline.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
  return ok;
};
const section = (s) => console.log(`\n-- ${s} ${'-'.repeat(Math.max(0, 72 - s.length))}`);

const PKG = fileURLToPath(new URL('..', import.meta.url));
const CALLSITES = resolve(process.env.CALLSITES || join(PKG, 'callsites.json'));

// -- the detector -------------------------------------------------------------------------
// A violation is a num_ctx (JS) or "num_ctx" (Python) assigned a NUMERIC LITERAL. The compliant
// form is a call (contextFor(...), context_for(...)) or a variable resolved from the table.
const LITERAL_NUM_CTX = /["']?num_ctx["']?\s*:\s*(\d+)/g;
const GENERATION_ENDPOINT = /\/api\/(generate|chat)\b/g;
const HAS_GENERATION_ENDPOINT = /\/api\/(generate|chat)\b/;
const POST_REQUEST = /\bmethod\s*:\s*["']POST["']|\.post\s*\(/;
const CONTEXT_HELPER_CALL = /\b(?:contextForTokens|contextFor|context_for)\s*\(/;
const CONTEXT_HELPER_CALL_ALL = /\b(?:contextForTokens|contextFor|context_for)\s*\(/g;

/** Remove prose comments before checking whether code references a context helper. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

/** Returns the literal num_ctx values found in `src` (empty array = compliant). */
function findLiteralContexts(src) {
  const hits = [];
  // strip line comments so explanatory prose ("num_ctx 40960 holds...") is not a false positive
  const code = src.replace(/^\s*(\/\/|#).*$/gm, '');
  for (const m of code.matchAll(LITERAL_NUM_CTX)) hits.push(Number(m[1]));
  return hits;
}

/** Returns generation/chat endpoints POSTed without any canonical context helper call. */
function findContextOmissions(src) {
  const code = withoutComments(src);
  if (!POST_REQUEST.test(code)) return [];
  const endpoints = [...code.matchAll(GENERATION_ENDPOINT)].map((m) => m[1]);
  if (endpoints.length === 0 || CONTEXT_HELPER_CALL.test(code)) return [];
  return [...new Set(endpoints)];
}

/** The in-memory omission mutation: the same source with every context helper call renamed. */
function dropContextHelpers(src) {
  return src.replace(CONTEXT_HELPER_CALL_ALL, 'noContextHelper(');
}

// -- 1. THE HARNESS PROVES ITSELF ---------------------------------------------------------
// A scanner that silently matches nothing would "pass" this whole file while the repo burned.
// Prove the detector FIRES on planted violations and STAYS QUIET on the compliant form, in both
// languages, before trusting a single real-file verdict.
section('harness proves itself (planted violations)');
// The planted fixtures spell the key through KEY rather than inline. The strings the detector
// sees are byte-identical at runtime; the indirection only keeps THIS file's fixtures out of the
// plain source greps that reviewers and CI run, because a grep cannot tell a planted fixture
// from a real call site. Do not "simplify" it back inline.
const KEY = 'num_ctx';
const plants = [
  t('detector catches a planted JS literal', findLiteralContexts(`options: { temperature: 0, ${KEY}: 8192 },`), [8192]),
  t('detector catches a planted Python literal', findLiteralContexts(`"options": {"temperature": 0.1, "${KEY}": 8192},`), [8192]),
  t('detector catches the planted 40960 literal that caused the outage',
    findLiteralContexts(`options: { ${KEY}: 40960, num_predict: 8192, temperature: 0.3 },`), [40960]),
];
const quiet = [
  t('detector is QUIET on the compliant JS form', findLiteralContexts(`options: { ${KEY}: contextFor(MODEL) },`), []),
  t('detector is QUIET on the compliant Python form', findLiteralContexts(`"options": {"${KEY}": context_for(MODEL)},`), []),
];
const prose = [
  t('detector ignores prose in JS comments', findLiteralContexts(`// ${KEY} 40960 holds the largest transcript`), []),
  t('detector ignores prose in Python comments', findLiteralContexts(`# ${KEY}: 8192 was the old value`), []),
];

const compliantJsFixture = `fetch('/api/generate', {
  method: 'POST',
  body: JSON.stringify({ options: { ${KEY}: contextFor(MODEL) } }),
});`;
const compliantPythonFixture = `requests.post(
  f"{OLLAMA}/api/generate",
  json={"options": {"${KEY}": context_for(MODEL)}},
)`;
const omissionPlants = [
  t('omission detector catches a planted JS /api/chat omission', findContextOmissions(`fetch('/api/chat', {
  method: 'POST', body: JSON.stringify({ model: MODEL }),
})`), ['chat']),
  t('omission detector catches a planted Python omission', findContextOmissions(`requests.post(
  f"{OLLAMA}/api/generate", json={"model": MODEL},
)`), ['generate']),
  t('a helper named only in a comment does not hide a planted omission', findContextOmissions(`fetch('/api/chat', {
  method: 'POST', body: JSON.stringify({ model: MODEL }),
});
// contextFor(MODEL) belongs in options
`), ['chat']),
];
quiet.push(
  t('omission detector is QUIET on the compliant JS form', findContextOmissions(compliantJsFixture), []),
  t('omission detector is QUIET on the compliant Python form', findContextOmissions(compliantPythonFixture), []),
);
const mutations = [
  t('omission detector catches a JS /api/generate omission mutation (helper removed in memory)',
    findContextOmissions(compliantJsFixture.replace(`options: { ${KEY}: contextFor(MODEL) }`, 'stream: false')), ['generate']),
  t('omission detector catches a Python omission mutation (helper renamed in memory)',
    findContextOmissions(dropContextHelpers(compliantPythonFixture)), ['generate']),
];

const planted = [...plants, ...omissionPlants];
t(`planted violations: all ${planted.length} plants caught`, planted.every(Boolean), true);
t(`in-memory omission mutation caught on every fixture (${mutations.length} of ${mutations.length})`, mutations.every(Boolean), true);
t(`comment prose is not flagged (${prose.length} prose lines stay quiet)`, prose.every(Boolean), true);
t('compliant forms stay quiet', quiet.every(Boolean), true);

// -- 2. THE SCAN ANCHORS ------------------------------------------------------------------
// A scan over zero files also "passes". Pin that the walk really reaches the known call sites.
section('scan anchors (the walk must reach every listed call site)');
const cfgOk = t('callsites.json exists', existsSync(CALLSITES), true);
const sites = cfgOk ? JSON.parse(readFileSync(CALLSITES, 'utf8')) : {};
const ROOT = resolve(dirname(CALLSITES), sites.root || '.');
const EXT = new Set(sites.extensions || ['.js', '.mjs', '.cjs', '.ts', '.py']);
const SKIP_DIRS = new Set(sites.skipDirs || ['node_modules', '.git', '.next', 'venv', '.venv', '__pycache__', 'dist', 'build']);
const SKIP_PATHS = (sites.skipPaths || []).map((p) => p.split('/').join(sep));
const CALL_SITES = sites.callSites || [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(name.slice(name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}
const files = existsSync(ROOT) ? walk(ROOT) : [];
const rel = (f) => relative(ROOT, f);
const scanned = files.filter((f) => !SKIP_PATHS.some((p) => rel(f).startsWith(p)));

t('callsites.json lists at least one call site (fill it in for your repo)', CALL_SITES.length > 0, true);
t('the walk found source files under root', scanned.length > 0, true);
const reached = new Set(scanned.map(rel));
// If one is renamed, this fails loudly rather than letting the scan silently stop covering it.
for (const f of CALL_SITES) t(`walk reaches ${f}`, reached.has(f.split('/').join(sep)), true);

// The in-memory omission mutation, on the real call sites: each one that POSTs to a generation
// endpoint must be compliant as written AND flagged once its context helper calls are removed.
// This proves the verdict in section 3 would catch a regression in exactly these files.
const posting = CALL_SITES
  .map((f) => join(ROOT, f))
  .filter((p) => existsSync(p))
  .map((p) => [rel(p), readFileSync(p, 'utf8')])
  .filter(([, src]) => POST_REQUEST.test(withoutComments(src)) && HAS_GENERATION_ENDPOINT.test(withoutComments(src)));
for (const [name, src] of posting) {
  t(`${name}: compliant as written`, findContextOmissions(src), []);
  t(`${name}: in-memory omission mutation is caught`, findContextOmissions(dropContextHelpers(src)).length > 0, true);
}

// -- 3. THE REAL VERDICT ------------------------------------------------------------------
section('no call site hardcodes a context window');
const violations = [];
const omissions = [];
for (const f of scanned) {
  const src = readFileSync(f, 'utf8');
  const hits = findLiteralContexts(src);
  if (hits.length) violations.push(`${rel(f)} -> num_ctx ${hits.join(', ')}`);
  const miss = findContextOmissions(src);
  if (miss.length) omissions.push(`${rel(f)} -> /api/${miss.join(', /api/')}`);
}
t(`zero hardcoded num_ctx literals (${scanned.length} file(s) scanned)`, violations, []);
t('zero /api/generate or /api/chat POST callers omit a context helper', omissions, []);

// -- verdict ------------------------------------------------------------------------------
console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
