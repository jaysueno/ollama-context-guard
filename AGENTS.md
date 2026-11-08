# AGENTS.md

Instructions for an AI agent working in this repo.

## Install

```bash
npm ci
```

Node 20 or newer (CI tests 20 and 22). There are no dependencies; `npm ci` only checks the lockfile. The audit
script and its test also need `bash`, `curl` and `python3`.

## Run

```bash
npm run check                         # the static check over callsites.json
bash scripts/context-audit.sh         # the runtime audit against OLLAMA_URL (default localhost)
```

## Test

```bash
npm test
```

CI runs the same `npm test` (`.github/workflows/ci.yml`). Every test is offline: fetch is
stubbed, and the audit test runs its own stub server on localhost and closes it.

## Where you may edit

- `lib/`, `scripts/`, `test/`: code and its tests. A new behavior needs a new assertion.
- `config/ollama-context.json`: only with a measurement behind the number. Raising a canonical
  window is a deliberate change that needs a new A/B on the target machine.
- `callsites.json`: keep `callSites` complete. Add every new file that sends to Ollama.
- `README.md`, `AGENTS.md`: plain technical prose.

## Where you may not edit

- The first section of `README.md` (the story under the title) is the owner's words. Leave it.
- `LICENSE`.

## Never

- Never pass a numeric `num_ctx` at a call site. Call `contextFor(model)`.
- Never weaken a detector or delete a planted-violation test to make the static check pass.
  If the check fails, the code is wrong, or the detector proved itself wrong first.
- Never grow a window to fit a big input. Chunk it.
- Never sweep `num_ctx` values against a shared model server that people are using. Every
  change is a full reload.
- Never add a real name, a home-folder path, an IP address, an email address, or a key, not
  even in a test. Use `localhost`, never a numeric loopback.
- Never use em dashes in prose.

## Before each commit

Run the identity and secret scan over the tree and the history: no names, home paths,
addresses, emails, or key shapes. The maintainer's scan reads a private term list named
`identity-terms.txt`, which is gitignored here so it can never ship. Then run `npm test`.
