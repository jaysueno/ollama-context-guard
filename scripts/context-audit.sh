#!/usr/bin/env bash
# context-audit.sh: the runtime half of "one model, one context window".
#
# Reads what Ollama has loaded right now (/api/ps) and, if a log path is given, the server log.
# Flags two things:
#   1. context drift: a runner loaded at a window that is neither its canonical value nor its
#      sanctioned escalation in config/ollama-context.json. Either a caller passed its own num_ctx,
#      or Ollama re-fitted the context to free memory. Both mean the runner is about to churn.
#   2. reload thrash: one model blob loaded more than THRASH_MAX_LOADS times in the last
#      THRASH_WINDOW_MIN minutes, counted from the server log.
#
# Why it exists (2026-07-28): two ad-hoc loads at -c 262144 came from a script run off a laptop,
# code that lived in no repo. No static check can see that. Drift and thrash still show up in
# /api/ps and in the log, whoever the caller is.
#
# Advisory only. It never restarts or unloads anything: a restart in the middle of a thrash is
# just one more reload.
#
# Environment (all optional):
#   OLLAMA_URL          default http://localhost:11434
#   OLLAMA_LOG          path to the Ollama server log; without it the thrash check is skipped
#   CONTEXT_CONFIG      default: config/ollama-context.json next to this script's folder
#   THRASH_WINDOW_MIN   default 15
#   THRASH_MAX_LOADS    default 4 (more loads than this for one model in the window = thrash)
#
# Output: one line. Exit 0 when clean or skipped, 1 when drift or thrash is found.
# Needs bash, curl and python3.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
API="${OLLAMA_URL:-http://localhost:11434}"
API="${API%/}"
CTX_CFG="${CONTEXT_CONFIG:-$HERE/../config/ollama-context.json}"
OLLAMA_LOG="${OLLAMA_LOG:-}"
THRASH_WINDOW_MIN="${THRASH_WINDOW_MIN:-15}"
THRASH_MAX_LOADS="${THRASH_MAX_LOADS:-4}"

[ -f "$CTX_CFG" ] || { echo "ctx-audit: SKIP (no config at $CTX_CFG)"; exit 0; }
ps_json=$(curl -fs -m 8 "$API/api/ps" 2>/dev/null) || { echo "ctx-audit: SKIP (/api/ps unreachable)"; exit 0; }

# A runner is OK at its canonical window OR at its sanctioned escalation (a long input may
# legitimately hold the big window for one run). Anything else is drift.
drift=$(CTX_CFG="$CTX_CFG" python3 -c '
import json,os,sys
ps=json.load(sys.stdin)
cfg=json.load(open(os.environ["CTX_CFG"]))
models=cfg.get("models",{}); esc=cfg.get("escalation",{}); default=cfg.get("default",8192)
def pick(tbl,m,fb=None):
    bare=m[:-7] if m.endswith(":latest") else m
    return tbl.get(m) or tbl.get(bare) or tbl.get(bare+":latest") or fb
bad=[]
for m in ps.get("models",[]):
    name=m.get("model") or m.get("name"); actual=m.get("context_length")
    want=pick(models,name,default); esc_v=pick(esc,name)
    if actual!=want and actual!=esc_v:
        bad.append(f"{name} loaded at {actual} (canonical {want}"+(f", escalation {esc_v}" if esc_v else "")+")")
print("; ".join(bad))' <<<"$ps_json" 2>/dev/null)

# Count model loads in the recent window, per model blob, straight from the server log.
thrash=""
if [ -n "$OLLAMA_LOG" ] && [ -f "$OLLAMA_LOG" ]; then
  thrash=$(WINDOW="$THRASH_WINDOW_MIN" MAXL="$THRASH_MAX_LOADS" python3 -c '
import os,re,sys,collections,datetime
win=int(os.environ["WINDOW"]); maxl=int(os.environ["MAXL"])
cutoff=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=win)
ts=None; counts=collections.Counter()
# only the tail matters; a busy server log runs to 100+ MB
lines=open(sys.argv[1],errors="ignore").readlines()[-40000:]
for ln in lines:
    m=re.match(r"time=(\S+)",ln)
    if m:
        try: ts=datetime.datetime.fromisoformat(m.group(1))
        except ValueError: ts=None
    if "loading model via llama-server" in ln and ts and ts>=cutoff:
        b=re.search(r"sha256-([0-9a-f]{8})",ln)
        counts[b.group(1) if b else "?"]+=1
print("; ".join(f"blob {k} loaded {v}x in {win}m" for k,v in counts.items() if v>maxl))' "$OLLAMA_LOG" 2>/dev/null)
fi

if [ -z "$drift" ] && [ -z "$thrash" ]; then
  echo "ctx-audit: OK"
  exit 0
fi
echo "ctx-audit: ${drift:+context drift: $drift. }${thrash:+reload thrash: $thrash.}"
exit 1
