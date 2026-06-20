#!/bin/sh
# Weekly deterministic consolidation of Hedwig's long-term memory (MEMORY.md).
# Runs as a Gateway command cron — NO LLM on purpose: a weak model rewriting memory
# would confabulate, and the system-prompt copy is truncated at bootstrapMaxChars, so
# an agent rewrite could silently drop the tail. Shell touches the full file directly.
#
# Does (safe, reversible):
#   1. snapshot MEMORY.md to an out-of-index archive (exact bytes, recoverable)
#   2. drop exact-duplicate non-blank lines (first occurrence kept, order preserved)
#   3. collapse runs of blank lines
# Does NOT (deferred): semantic/paraphrase dedup and staleness updates — those need an
# LLM with full-file read access (a tools.allow + security tradeoff), see HEDWIG-OPS.
set -eu

WS="${OPENCLAW_STATE_DIR:-/data}/workspace"
MEM="$WS/MEMORY.md"
# Archive lives OUTSIDE memory/ so old snapshots are not re-indexed into memory_search
# (which would resurface stale facts). Recovery is a manual copy, not search.
ARCHIVE="$WS/.memory-archive"

[ -f "$MEM" ] || { echo "mem-consolidate: no MEMORY.md, skip"; exit 0; }
bytes=$(wc -c < "$MEM")
# Skip near-empty memory (just the heading): nothing to consolidate, avoid archive churn.
if [ "$bytes" -lt 40 ]; then
  echo "mem-consolidate: MEMORY.md near-empty (${bytes}b), skip"
  exit 0
fi

mkdir -p "$ARCHIVE"
stamp=$(date +%F)
cp "$MEM" "$ARCHIVE/MEMORY-$stamp.md"

before=$(wc -l < "$MEM")
tmp="$MEM.tmp.$$"
# Blank line -> at most one consecutive; non-blank line -> printed only on first sight.
awk '
  /^[[:space:]]*$/ { if (!blank) print ""; blank=1; next }
  { blank=0; if (!seen[$0]++) print }
' "$MEM" > "$tmp"

# Safety: never replace MEMORY.md with empty output; keep the original if dedup emptied it.
if [ -s "$tmp" ]; then
  mv "$tmp" "$MEM"
else
  rm -f "$tmp"
  echo "mem-consolidate: dedup produced empty output, kept original"
  exit 0
fi

after=$(wc -l < "$MEM")
echo "mem-consolidate: $stamp lines $before -> $after (snapshot: .memory-archive/MEMORY-$stamp.md)"

# Bound disk/growth: keep only the 8 most recent weekly snapshots.
ls -1t "$ARCHIVE"/MEMORY-*.md 2>/dev/null | tail -n +9 | while IFS= read -r old; do
  rm -f "$old"
done
