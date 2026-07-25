#!/usr/bin/env node
// ask-pipe v0 / T1: event-driven mail-alert forwarder (gateway command cron).
//
// EXP-001 (constitution §3.5 experiment lane, 2026-07-25). Reversible/free/own-store:
// no LLM, no new billing, no new external surface, no new state. Deletable cron +
// revertable Dockerfile COPY = B-class rollback. See ~/hedwig-eval/EXPERIMENTS.md.
//
// Hypothesis: standalone event-driven pushes get replies where brief-embedded
// ask-back (6)(7) got 0 replies over 8 fires (7/18 census). This is the delivery-
// mechanism test device.
//
// T1 only: forward hedwig-cal /alerts verbatim. The server owns the dedup cursor
// (getAlerts advances it every call and bootstraps to "now" on a fresh deploy, so
// the backlog is never blasted), which is why this poller stays STATELESS and needs
// no SQLite — the design's measurement ledger is a fast-follow, added only if T1
// actually fires. Quiet hours (JST 0-8) are enforced by the cron schedule
// (`*/30 8-23 * * *` Asia/Tokyo), so this script carries no clock.
//
// Output contract: alert lines -> stdout (announce delivers to Telegram); nothing to
// forward -> exactly "NO_REPLY" (announce suppressed). ALL diagnostics go to stderr
// so `2>/dev/null` on the cron keeps stdout a clean token (a mixed stdout+stderr
// summary breaks NO_REPLY suppression — the lift-report leak lesson).
//
// Env (inherited from gateway secrets by command cron): HEDWIG_CAL_BASE, and
// HEDWIG_CAL_TOKEN | CAL_PROXY_TOKEN. ASK_PIPE_MAX (cap lines per poll, default 3).

const BASE = (process.env.HEDWIG_CAL_BASE || "").replace(/\/+$/, "");
const TOKEN = process.env.HEDWIG_CAL_TOKEN || process.env.CAL_PROXY_TOKEN || "";
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

async function getAlerts() {
  // 20s cap: a missed poll is a gap, not an error — never alarm, just stay silent
  // this tick (hedwig-cal autostops and a poll may hit a cold start).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${BASE}/alerts`, {
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

const data = await getAlerts();
if (!data || data.bootstrapped || !Array.isArray(data.alerts) || data.alerts.length === 0) {
  diag(data?.bootstrapped ? "cursor bootstrapped (fresh), nothing to send" : "no alerts");
  silent();
}

// Verbatim forward: each alert.line is a server-confirmed string (echo-back
// doctrine — the model/poller never rewrites it). Cap per poll so a burst can't
// flood; alerts are score>=3 fresh mail (rare), so truncation is very unlikely.
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
