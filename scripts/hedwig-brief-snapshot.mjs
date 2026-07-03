#!/usr/bin/env node
// Brief-candidate SNAPSHOT (Gateway command cron, deterministic, no LLM = ¥0).
//
// Screw #1 of the behavioral-correlation harness (memo project_hedwig_brief_eval_loop).
// Explicit-feedback signal is structurally absent (42 briefs -> 3 replies, 0 reactions),
// so the plan switched from "ask" to "observe": did the owner touch a briefed item
// within a few hours? To measure that we first need the ground truth of WHAT was on
// offer at brief time and WHICH items were pushed vs suppressed. This cron freezes
// exactly that pool, deterministically, twice a day next to the briefs.
//
// The brief itself is LLM prose with no candidate ledger. But /mail already returns a
// score-sorted pool, so the decision (pushed vs suppressed) is DERIVED from the server
// score, not parsed from the prose:
//   pushed             — score >= PUSH_MIN AND rank < PUSH_TOP_N (what the brief surfaces)
//   suppressed/below_threshold — score < PUSH_MIN (never eligible; a valid control arm)
//   suppressed/low_priority    — score >= PUSH_MIN but rank >= PUSH_TOP_N (a valid control arm)
// Only below_threshold/low_priority are usable as controls; duplicate/stale are not
// observable from a single pool snapshot, so we do not invent them here.
//
// Stored fields are join keys + scores only (thread_id/msg_id/score/decision). NO subject,
// sender, or snippet: the ledger stays PII-free. thread_id is the join key screw #2 (the
// owner-action lookup) will match on. msg_id is the drill-down anchor. latency is NOT
// baked in: screw #2 records observed_action(observed_at, latency_minutes) and the 6h
// threshold is chosen at analysis time.
//
// Why a command cron (node): deterministic, free, no confabulation, and it can write the
// VM's /data SQLite which hedwig-cal (volume-less, autostop) cannot host. Idempotent:
// re-running for the same brief slot/day inserts nothing new (INSERT OR IGNORE on
// UNIQUE(brief_run_id, msg_id)).
//
// Env: HEDWIG_CAL_TOKEN|CAL_PROXY_TOKEN (proxy auth), HEDWIG_CAL_BASE (proxy base URL),
// OPENCLAW_STATE_DIR (/data), SNAPSHOT_LIMIT (15 = /mail max pool), PUSH_TOP_N (3),
// PUSH_MIN_SCORE (1), BRIEF_SNAPSHOT_DB (override db path),
// BRIEF_SNAPSHOT_DRYRUN=1 (compute + print, do not write).
import { DatabaseSync } from "node:sqlite";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const DB_PATH = process.env.BRIEF_SNAPSHOT_DB || `${STATE}/hedwig-brief-eval.sqlite`;
const BASE = (process.env.HEDWIG_CAL_BASE || "https://hedwig-cal.fly.dev").replace(/\/+$/, "");
const TOKEN = process.env.HEDWIG_CAL_TOKEN || process.env.CAL_PROXY_TOKEN || "";
const LIMIT = Number(process.env.SNAPSHOT_LIMIT || 15); // /mail caps at 15 (top-N of a ~40 pool)
const PUSH_TOP_N = Number(process.env.PUSH_TOP_N || 3); // brief surfaces score>=1 top 2-3
const PUSH_MIN = Number(process.env.PUSH_MIN_SCORE || 1);
const DRYRUN = process.env.BRIEF_SNAPSHOT_DRYRUN === "1";
const log = (m) => console.log(`brief-snapshot: ${m}`);

if (!TOKEN) {
  log("no HEDWIG_CAL_TOKEN/CAL_PROXY_TOKEN, skip");
  process.exit(0);
}

// JST clock (briefs are scheduled Asia/Tokyo). Shift +9h then read UTC fields so we
// never depend on ICU/timezone data being present in the slim runtime image.
const nowJst = new Date(Date.now() + 9 * 3600_000);
const y = nowJst.getUTCFullYear();
const mo = String(nowJst.getUTCMonth() + 1).padStart(2, "0");
const d = String(nowJst.getUTCDate()).padStart(2, "0");
const hour = nowJst.getUTCHours();
const dateStr = `${y}${mo}${d}`;
// Slot from the JST hour: the two briefs are 07:00 / 21:00, snapshots fire at :02.
const slot = hour < 12 ? "morning" : "evening";
const briefRunId = `${slot}-${dateStr}`;

// --- fetch the same scored pool the brief drew from (Bearer keeps the token out of URLs/logs) ---
async function fetchPool() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000); // proxy autostops; allow a cold start
  try {
    const r = await fetch(`${BASE}/mail?limit=${LIMIT}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`/mail HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j.messages) ? j.messages : [];
  } finally {
    clearTimeout(t);
  }
}

let pool;
try {
  pool = await fetchPool();
} catch (e) {
  log(`fetch failed: ${String(e.message).slice(0, 120)}`);
  process.exit(0); // a missed snapshot is a gap, not an error worth alerting
}

// /mail already returns score-desc; rank is the position in that order. Decision is a
// pure function of (score, rank) so the ledger is reproducible from the raw pool.
const t0 = Date.now();
const rows = pool.map((m, rank) => {
  let decision = "suppressed";
  let suppressReason = null;
  if (m.score < PUSH_MIN) {
    suppressReason = "below_threshold";
  } else if (rank < PUSH_TOP_N) {
    decision = "pushed";
  } else {
    suppressReason = "low_priority";
  }
  return {
    briefRunId,
    slot,
    capturedAt: t0,
    targetKind: "mail",
    threadId: m.threadId || null,
    msgId: m.id || null,
    score: Number.isFinite(m.score) ? m.score : 0,
    rank,
    decision,
    suppressReason,
    needsReply: m.needsReply ? 1 : 0,
    ageDays: Number.isInteger(m.ageDays) ? m.ageDays : null,
  };
});

const counts = rows.reduce((a, r) => {
  const k = r.decision === "pushed" ? "pushed" : r.suppressReason;
  a[k] = (a[k] || 0) + 1;
  return a;
}, {});
const summary = `${briefRunId}: ${rows.length} candidate(s) [${Object.entries(counts)
  .map(([k, v]) => `${k}=${v}`)
  .join(" ")}]`;

if (DRYRUN) {
  log(`(dry-run, not written) ${summary}`);
  process.exit(0);
}

// --- persist to the dedicated brief-eval ledger (/data SQLite, node-owned) ---
// Dedicated DB, not the OpenClaw state store: this is operator measurement data with its
// own schema/lifecycle (accumulate for weeks, analyzed by local eval scripts, disposable
// if lift ~= 0). Low-level bootstrap DDL is the exempt case for raw SQL.
const db = new DatabaseSync(DB_PATH);
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_candidate (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      brief_run_id    TEXT    NOT NULL,
      slot            TEXT    NOT NULL,
      captured_at     INTEGER NOT NULL,
      target_kind     TEXT    NOT NULL,
      thread_id       TEXT,
      msg_id          TEXT    NOT NULL,
      score           INTEGER NOT NULL,
      rank            INTEGER NOT NULL,
      decision        TEXT    NOT NULL,
      suppress_reason TEXT,
      needs_reply     INTEGER NOT NULL,
      age_days        INTEGER,
      UNIQUE(brief_run_id, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bc_thread ON brief_candidate(thread_id);
    CREATE INDEX IF NOT EXISTS idx_bc_run ON brief_candidate(brief_run_id);
  `);
  const ins = db.prepare(`
    INSERT OR IGNORE INTO brief_candidate
      (brief_run_id, slot, captured_at, target_kind, thread_id, msg_id,
       score, rank, decision, suppress_reason, needs_reply, age_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const r of rows) {
    const res = ins.run(
      r.briefRunId,
      r.slot,
      r.capturedAt,
      r.targetKind,
      r.threadId,
      r.msgId,
      r.score,
      r.rank,
      r.decision,
      r.suppressReason,
      r.needsReply,
      r.ageDays,
    );
    inserted += Number(res.changes) || 0;
  }
  log(`${summary} -> ${inserted} new row(s)`);
} finally {
  db.close();
}
