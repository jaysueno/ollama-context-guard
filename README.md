# ollama-context-guard

On July 28, 2026 receipt capture in my ops app spun for forty minutes with no error anywhere, while
every health probe stayed green. Two scripts had asked the same 27B model for different context
windows, and Ollama answered each request with a full 19 GB reload, evicting the other. The fix was
not a bigger window. It was one window per model, defined once, read by every caller, with a static
check that fails the build on a stray number and a runtime check that reads the model server's own
log. Measured on the same five receipts: the window cost nothing in compute. The reload cost
everything.

## What it does

Five small pieces that keep every caller of a shared Ollama server on one context window per
model. Node 20 or newer, zero dependencies.

| Piece | What it is |
|---|---|
| `config/ollama-context.json` | The table: one canonical `num_ctx` per model, plus an escalation table for the one sanctioned exception. Plain JSON, so a Python or shell caller reads the same file. |
| `lib/ollama-context.js` | `contextFor(model)` returns the window to send. Also `contextForTokens`, `willTruncate`, `estimateTokens`, `auditLoadedContexts` (reads `/api/ps`), and a guard that refuses to load a big Ollama model while a second engine owns the GPU. A second engine means another local inference server on the same machine, for example a llama.cpp server, selected with `LOCAL_LLM_BACKEND=engine`. Imports only `node:fs`. |
| `lib/voice-chunking.js` and `lib/guarded-generate.js` | When input does not fit, shrink the request: split a long transcript into sections that each fit, and refuse to send an oversized prompt instead of letting Ollama cut it silently. |
| `test/discipline.test.mjs` + `callsites.json` | The static check. Fails the build on any literal `num_ctx`, and on any POST to `/api/generate` or `/api/chat` that does not call a context helper. It proves its own detectors first. |
| `scripts/context-audit.sh` | The runtime check. Reads `/api/ps` and the server log; flags a runner loaded at a window that is neither canonical nor the sanctioned escalation, and a model loaded more than 4 times in 15 minutes. |

## Run it

**Send the canonical window, never a number.**

```js
import { contextFor } from './lib/ollama-context.js';

const body = { model, prompt, stream: false, options: { num_ctx: contextFor(model) } };
```

Or let `generate()` build the request and refuse one that would not fit:

```js
import { generate } from './lib/guarded-generate.js';

const { raw } = await generate('http://localhost:11434', { model: 'qwen3.8:27b', prompt });
```

A Python caller reads the same table (Python 3.9 or newer, for `str.removesuffix`):

```python
import json

_CFG = json.load(open("config/ollama-context.json"))

def context_for(model):
    # same lookup order as contextFor() in JS: exact tag, bare tag, bare tag + ":latest"
    bare = model.removesuffix(":latest")
    for key in (model, bare, bare + ":latest"):
        if key in _CFG["models"]:
            return _CFG["models"][key]
    return _CFG["default"]
```

**Fill in the table for your machine.** Put each model tag you run under `models` with the
largest window that reliably fits your free memory (see "How it works" for how to measure it).
`lane-a` and `lane-b` stand for tags that run with a larger window on purpose; replace them
with your own or delete them.

**Point the static check at your repo.** Edit `callsites.json`: `root` is the folder to walk,
`callSites` lists every file that sends a request to Ollama, `skipPaths` lists folders that are
not production callers. Then:

```bash
npm run check
# or, from a copy of this repo, against another one:
CALLSITES=/path/to/your/repo/callsites.json node test/discipline.test.mjs
```

**Run the runtime audit** on the machine that serves Ollama, by hand or every five minutes from
cron or launchd:

```bash
OLLAMA_LOG=~/.ollama/logs/server.log bash scripts/context-audit.sh
```

`~/.ollama/logs/server.log` is where the macOS app writes its log. On Linux, point
`OLLAMA_LOG` at the file your service writes. It prints one line and exits 1 on drift or
thrash, 0 when clean. Other settings: `OLLAMA_URL` (default `http://localhost:11434`),
`CONTEXT_CONFIG`, `THRASH_WINDOW_MIN` (15), `THRASH_MAX_LOADS` (4).

## Test it

[![ci](https://github.com/jaysueno/ollama-context-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/jaysueno/ollama-context-guard/actions/workflows/ci.yml)

```bash
npm ci
npm test
```

150 assertions across four files, no model and no network. The audit test also needs `bash`,
`curl` and `python3`, like the script.

- `test/discipline.test.mjs` plants violations and must catch every one, runs an in-memory
  omission mutation (a compliant call with its context helper removed must be flagged, on the
  fixtures and on every listed call site), and checks that comment prose is not flagged. Only
  then does it scan the repo. It refuses an empty `callSites` list.
- `test/context.test.mjs` pins the table, the exact boundary of the length gate, the
  truncation report, the runtime audit in JavaScript against a stubbed `/api/ps`, and the
  co-residency guard.
- `test/voice-chunking.test.mjs` proves the chunker never drops a character, never exceeds its
  budget, and that every section request of a 150,000-character transcript fits the canonical
  window. It ends with the request builder under a stubbed `fetch`: an oversized prompt throws
  instead of truncating silently, and never reaches the network.
- `test/context-audit.test.mjs` runs the shell audit against a stub server on localhost and
  generated server logs: drift, thrash, the window edge, and the cases that must skip without a
  false alarm.

## How it works

```text
            config/ollama-context.json  (one window per model)
                 |                     |
      contextFor(model)          context-audit.sh reads it
                 |                     |
  caller A --+   |                     v
  caller B --+-> num_ctx = 16384   /api/ps: what is loaded, at what window?
  caller C --+   (same for all)   server log: how often did each model load?
                 |                     |
                 v                     v
        one runner stays loaded    drift or thrash -> one line, exit 1

  test/discipline.test.mjs: no literal num_ctx, no POST without contextFor(), in CI
```

### One runner per model, fixed at load time

Ollama keeps one runner per model, and that runner's context is fixed when it loads, by
whichever caller loaded it. A second caller asking the same model for a different `num_ctx`
does not queue. It forces a full unload and reload. For `qwen3.6:27b` that is about 19 GB.

Two callers with different windows therefore thrash: each load evicts the other's, and a
caller whose load is evicted mid-flight gets
`client connection closed before llama-server finished loading, aborting load` and hangs until
its own timeout. Ollama's `OLLAMA_LOAD_TIMEOUT` then returns 500 at exactly 5m0s.

On July 28, 2026 the receipt reader used a literal 8192 and a voice-memo summarizer used a
literal 40960 with a 5-attempt retry loop. A memo synced, a file watcher started the
summarizer, and for about 40 minutes (16:05 to 16:46) every receipt read died at its timeout.
Receipt capture in the app spun with no error anywhere.

### `num_ctx` is a request, not a guarantee

Ollama 0.30.7's scheduler re-fits the context to free system memory at load time and logs the
decision:

```text
msg="llama-server model fits alongside existing models"
predicted="17.8 GiB" predicted_num_ctx=16384 available="29.1 GiB" system_free="29.1 GiB"
```

Measured on a 64 GB Mac Mini on July 28, a request for 40960 (needs 20.3 GiB):

| `system_free` | granted `num_ctx` |
|---|---|
| 48.5 / 32.1 / 31.1 GiB | 40960 (honored) |
| 29.3 / 29.1 GiB | **16384** (silently downsized) |

The machine moved between 27 and 32 GiB free, right across that boundary. So an
unconditional 40960 was granted or downsized depending on memory at that moment, and every
change was a full reload of about 19 GB. A/B over 5 real receipts, same images, same prompt:

| | avg wall | reloads | compute |
|---|---|---|---|
| `num_ctx` 8192 (17.4 GiB) | **63.4 s** | 0 (`load=0.3s` every call) | prompt 2962 tok/25.6 s, out 463 tok/37.3 s |
| `num_ctx` 40960 (20.3 GiB) | **110.7 s** | 2 (`load=95.5s`, `141.9s`) | *identical, to the decimal* |

**The window costs nothing in compute. The reload costs everything.** So the canonical value
is not the biggest window anyone needs. It is the biggest that reliably fits. For
`qwen3.6:27b` that was 16384 (17.8 GiB, granted at 29.1 GiB free), which held every
receipt-reading and text-classification request with room to spare.

### Oversized input: chunk it, do not grow the window

Voice transcripts, measured over 177 recordings: p50 1,495 tokens, p90 8,919, p99 23,271, max
30,238. The window must hold the prompt and the completion. With an 8192-token completion
budget, half the canonical window, about 5,000 tokens are left for the transcript once the
fixed prompt (about 1,656 tokens) is paid. A 55-minute recording is about 8,000 tokens and does
not fit.

The first answer was a length-gated escalation to 40960. It ended on August 20, 2026. On
`qwen3.6:27b` the escalation predicted 20.3 GiB and merely cost a reload. After the move to
`qwen3.8:27b-q8_0` the same request predicted 35.5 GiB, more than the machine reliably had
free, so Ollama logged `model predicted to exceed available memory, evicting` and refused the
load. The client gave up at its 5-minute timeout, all 5 retries burned, and the recording was
deferred forever. Short recordings kept summarizing, so no alert fired. A 55-minute meeting sat
unsummarized for a day before anyone noticed.

The rule since then: when input does not fit, shrink the request, not the window.
`lib/voice-chunking.js` splits the transcript into consecutive sections that each fit the
canonical window, digests each one, then summarizes the digests. Sections are sized to the
number of digests the final call can hold (more, smaller sections keep more detail), and a tiny
trailing section is folded back into its neighbor. Nothing is ever truncated: if a request
cannot be bounded, the code throws. `contextForTokens()` and the escalation table stay for a
future caller whose input truly cannot be chunked. Before you add one, do the memory math for
your model: an escalation that does not fit fails as a hang, not as an error.

### The guard has two halves

1. **Static** (`test/discipline.test.mjs`): scans every `.js`, `.mjs`, `.cjs`, `.ts` and `.py`
   file under `root` and fails on any literal `num_ctx` or any POST to `/api/generate` or
   `/api/chat` that does not call `contextFor`, `context_for` or `contextForTokens`. Before any
   verdict counts it proves its detectors: planted violations must be caught, an in-memory
   omission mutation must be caught, comment prose must not be flagged, and the walk must reach
   every file in `callSites`.
2. **Runtime** (`scripts/context-audit.sh`): reads `/api/ps` and the server log, and flags a
   runner loaded at neither the canonical nor the sanctioned window, or one model loading more
   than 4 times in 15 minutes. Advisory only: it never restarts Ollama, because a restart in the
   middle of a thrash is one more reload.

Because Ollama re-fits to memory, the runtime check can fire with no caller at fault. That is
intended: it means the machine is under memory pressure and the runner is about to churn.

The runtime half is not redundant. On July 28 two `-c 262144` loads came from an ad-hoc script
run off a laptop, code that lived in no repo. The same day a diagnostic agent swept six window
sizes against the live server in about 90 seconds. Whatever the caller, drift and thrash show up
in `/api/ps` and the log. Probing a shared model server is itself a load event: diagnose from
`/api/ps` and the logs, and do not sweep `num_ctx` values while the app is in use.

### What "healthy" does not mean

The server's health probe passed every 5 minutes through the whole outage. It ran
`nomic-embed-text` (0.37 GB), which is never the model being thrashed. The port can be open,
the API up and a tiny model answering while the 19 GB model cannot answer at all. Probe the
capability that is failing.

## What it will not do

- **It does not measure your machine.** The numbers above come from one 64 GB Mac Mini,
  running Ollama server version 0.30.7 for the July measurements and 0.32.13 for the August
  `qwen3.8` measurements. Measure your own boundary before you pick a window.
- **It does not parse code.** The static check matches patterns: a literal after `num_ctx`, and
  a POST to a generation endpoint in a file that never calls a context helper. A window passed
  through a variable that holds a hardcoded number gets past it.
- **It only sees what `callsites.json` points it at.** Callers outside `root` are invisible to
  the static check. The runtime audit is there for them.
- **It never restarts, unloads or reconfigures Ollama,** and it sends no alerts itself. Pipe its
  output to whatever notifies you.
- **It ships no model and calls none.** Every test runs offline.

## License

MIT. See `LICENSE`.
