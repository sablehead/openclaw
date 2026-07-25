#!/usr/bin/env node
// ask-pipe v0 / T1: event-driven mail-alert forwarder (gateway command cron).
//
// EXP-001 (constitution §3.5 experiment lane, 2026-07-25). Reversible/free/own-store:
// no LLM, no new billing, no new external surface. Deletable cron + revertable
// Dockerfile COPY = B-class rollback. See ~/hedwig-eval/EXPERIMENTS.md.
//
// Hypothesis: standalone event-driven pushes get replies where brief-embedded
// ask-back (6)(7) got 0 replies over 8 fires (7/18 census). This is the delivery-
// mechanism test device.
//
// T1 only: forward hedwig-cal /alerts verbatim. The dedup cursor lives HERE, on the
// gateway's persistent /data (SQLite kv) — NOT on hedwig-cal, whose rootfs is wiped
// on every autostop cold start (verified 2026-07-25: a stop/start drops its
// /home/node cursor, so a server-held cursor re-bootstraps every poll and never
// alerts). We pass ?since=<stored> and persist the returned `cursor`. First run
// (no stored cursor) bootstraps: mark now, send nothing, no backlog blast. Quiet
// hours (JST 0-8) are enforced by the cron schedule (`*/30 8-23 * * *` Asia/Tokyo).
//
// Output contract: alert lines -> stdout (announce delivers to Telegram); nothing to
// forward -> exactly "NO_REPLY" (announce suppressed). ALL diagnostics + the
// node:sqlite ExperimentalWarning go to stderr, so `2>/dev/null` on the cron keeps
// stdout a clean token (a mixed stdout+stderr summary breaks NO_REPLY suppression —
// the lift-report leak lesson).
//
// Env (inherited from gateway secrets by command cron): HEDWIG_CAL_BASE, and
// HEDWIG_CAL_TOKEN | CAL_PROXY_TOKEN. OPENCLAW_STATE_DIR (/data). ASK_PIPE_MAX
// (cap lines per poll, default 3).
import { DatabaseSync } from "node:sqlite";

const BASE = (process.env.HEDWIG_CAL_BASE || "").replace(/\/+$/, "");
const TOKEN = process.env.HEDWIG_CAL_TOKEN || process.env.CAL_PROXY_TOKEN || "";
const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const DB_PATH = `${STATE}/hedwig-ask-pipe.sqlite`;
const MAX = Number(process.env.ASK_PIPE_MAX || 3);

const diag = (m) => console.error(`ask-pipe: ${m}`);
const silent = () => {
  // The only thing that ever reaches stdout on the silent path.
  console.log("NO_REPLY");
  process.exit(0);
};

if (!BASE || !TOKEN) {
  diag("no HEDWIG_CAL_BASE/TOKEN, skip");
  silent();
}

// Cursor persistence on the gateway's own /data — the whole point of the fix.
let db;
try {
  db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v INTEGER)");
} catch (e) {
  diag(`db open failed: ${String(e.message).slice(0, 120)}`);
  silent();
}
const readCursor = () => {
  const row = db.prepare("SELECT v FROM kv WHERE k = 'cursor'").get();
  return row ? Number(row.v) : null;
};
const writeCursor = (v) => {
  db.prepare(
    "INSERT INTO kv (k, v) VALUES ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  ).run(v);
};

async function fetchAlerts(url) {
  // 20s cap: a missed poll is a gap, not an error — never alarm, just stay silent
  // this tick (hedwig-cal autostops and a poll may hit a cold start). On failure
  // we leave the cursor untouched, so the next poll retries the same window and no
  // mail is lost.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      diag(`/alerts HTTP ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    diag(`fetch failed: ${String(e.message).slice(0, 120)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const stored = readCursor();
const url = stored === null ? `${BASE}/alerts` : `${BASE}/alerts?since=${stored}`;
const data = await fetchAlerts(url);
if (!data) silent();

// Advance the persisted cursor whenever the server hands one back, even on the
// silent path — the server's cursor jumps past everything scanned (not just
// alerted), so persisting it here is what prevents re-evaluating low-score mail.
if (typeof data.cursor === "number") writeCursor(data.cursor);

if (data.bootstrapped || !Array.isArray(data.alerts) || data.alerts.length === 0) {
  diag(data.bootstrapped ? "bootstrapped (no stored cursor), marked now" : "no alerts");
  silent();
}

// Verbatim forward: each alert.line is a server-confirmed string (echo-back
// doctrine — the poller never rewrites it). Cap per poll so a burst can't flood;
// alerts are score>=3 fresh mail (rare), so truncation is very unlikely.
const lines = data.alerts
  .map((a) => (a && typeof a.line === "string" ? a.line.trim() : ""))
  .filter(Boolean)
  .slice(0, MAX);

if (lines.length === 0) {
  diag("alerts present but no usable line field");
  silent();
}

diag(`forwarding ${lines.length} alert line(s)`);
console.log(lines.join("\n"));
