#!/usr/bin/env node
// Weekly brief "editorial meeting" (Gateway command cron, deterministic, no LLM = ¥0).
//
// The suggest rung of the autonomy ladder (memo project_hedwig_self_improve_loop):
// turn the behavioral-correlation ledger (brief_candidate x observed_action, screws
// #1/#2 of project_hedwig_brief_eval_loop) into a short owner-facing digest with a
// rule-based editorial PROPOSAL. Numbers are computed here from the ledger — the
// same server-owned-truth doctrine as the briefs (no model narrates, so nothing can
// be confabulated). This cron NEVER changes any setting: it only proposes; acting
// on a proposal stays a human decision (suggest -> draft -> act stays gated).
//
// Silence protocol: prints NO_REPLY (announce suppressed) until the ledger has
// enough mature data to say anything honest — a young harness would otherwise
// emit weekly noise. Mature = captured >= 26h ago (both observe ticks have run).
//
// Env: OPENCLAW_STATE_DIR (/data), BRIEF_SNAPSHOT_DB (same ledger as the snapshot
// cron), LIFT_HOURS (6), LIFT_MIN_DAYS (7), LIFT_MIN_PUSHED (20),
// LIFT_MIN_CONTROL (60), LIFT_REPORT_FORCE=1 (bypass the data gate, for testing).
import { DatabaseSync } from "node:sqlite";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const DB_PATH = process.env.BRIEF_SNAPSHOT_DB || `${STATE}/hedwig-brief-eval.sqlite`;
const HOURS = Number(process.env.LIFT_HOURS || 6);
const HOURS_MS = HOURS * 3600_000;
const MIN_DAYS = Number(process.env.LIFT_MIN_DAYS || 7);
const MIN_PUSHED = Number(process.env.LIFT_MIN_PUSHED || 20);
const MIN_CONTROL = Number(process.env.LIFT_MIN_CONTROL || 60);
const FORCE = process.env.LIFT_REPORT_FORCE === "1";
const MATURE_MS = 26 * 3600_000; // past both observe ticks (~10-14h and ~24h)

const silent = (why) => {
  // stderr keeps the reason findable in the cron run-log; stdout stays exactly
  // NO_REPLY so the announce delivery is suppressed (quiet weeks are normal).
  console.error(`lift-report: silent (${why})`);
  console.log("NO_REPLY");
  process.exit(0);
};

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch {
  silent("no ledger yet");
}

const now = Date.now();
let candidates, actions;
try {
  candidates = db
    .prepare(
      `SELECT brief_run_id, captured_at, thread_id, score, rank, decision, suppress_reason
       FROM brief_candidate WHERE captured_at <= ?`,
    )
    .all(now - MATURE_MS);
  const hasActions = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='observed_action'`)
    .all().length;
  actions = hasActions
    ? db.prepare(`SELECT target_ref, action, acted_at, at_exact FROM observed_action`).all()
    : [];
} finally {
  db.close();
}

const byThread = new Map();
for (const a of actions) {
  if (!byThread.has(a.target_ref)) byThread.set(a.target_ref, []);
  byThread.get(a.target_ref).push(a);
}

// Same judgment as the local analyzer (~/hedwig-eval/brief-lift.mjs): strict =
// action provably within HOURS (bound rows count only when the bound itself is
// inside the window); loose = any post-capture action. Keep the two in sync.
function judge(c) {
  let strict = null;
  let loose = null;
  for (const a of byThread.get(c.thread_id) || []) {
    if (a.acted_at <= c.captured_at) continue;
    const lat = a.acted_at - c.captured_at;
    if (!loose || lat < loose.lat) loose = { action: a.action, lat };
    if (lat <= HOURS_MS && (!strict || lat < strict.lat)) strict = { action: a.action, lat };
  }
  return { strict, loose };
}

const g = {
  pushed: { n: 0, strict: 0, loose: 0 },
  control: { n: 0, strict: 0, loose: 0 },
};
const misses = []; // suppressed candidates the owner acted on anyway
for (const c of candidates) {
  const grp = c.decision === "pushed" ? g.pushed : g.control;
  const { strict, loose } = judge(c);
  grp.n++;
  if (strict) grp.strict++;
  if (loose) {
    grp.loose++;
    if (c.decision !== "pushed") {
      misses.push({
        score: c.score,
        rank: c.rank,
        reason: c.suppress_reason,
        action: loose.action,
        hours: Math.round(loose.lat / 3600_000),
      });
    }
  }
}

const days = new Set(candidates.map((c) => c.brief_run_id.split("-")[1])).size;
if (!FORCE && (days < MIN_DAYS || g.pushed.n < MIN_PUSHED || g.control.n < MIN_CONTROL)) {
  silent(
    `data gate: days=${days}/${MIN_DAYS} pushed=${g.pushed.n}/${MIN_PUSHED} control=${g.control.n}/${MIN_CONTROL}`,
  );
}

const pct = (x, n) => (n ? `${((x / n) * 100).toFixed(1)}%` : "n/a");
const rate = (x, n) => (n ? x / n : 0);
const liftStrict = rate(g.pushed.strict, g.pushed.n) - rate(g.control.strict, g.control.n);
const liftLoose = rate(g.pushed.loose, g.pushed.n) - rate(g.control.loose, g.control.n);
const totalActed = g.pushed.loose + g.control.loose;
const pt = (x) => `${(x * 100).toFixed(1)}pt`;

// Rule-based proposal: one sentence, picked from closed outcomes. No free text.
let proposal;
if (totalActed === 0) {
  proposal =
    "提案なし＝この期間、メールへの行動（返信/アーカイブ/既読）が観測ゼロ。選択の良し悪し以前に行動シグナルが枯れているため、蓄積を継続して次回判読で再評価。";
} else if (
  misses.length >= 3 &&
  rate(g.control.loose, g.control.n) >= rate(g.pushed.loose, g.pushed.n)
) {
  proposal =
    "見逃し側で行動が起きています。score 閾値/重み（personalBoost・NOTIFY_CAP）の見直しを検討する段階です（上の見逃し内訳の score 帯が調整対象の候補）。";
} else if (liftLoose > 0.03) {
  proposal = "push した候補ほど行動されており、現在の選択は機能しています。現状維持を提案。";
} else {
  proposal =
    "リフト≈0＝push の有無が owner の行動を変えていません。閾値調整でなく「何を出すか」の再設計を検討（memo project_hedwig_brief_eval_loop の GO/NO-GO 節）。";
}

const missLines = misses
  .slice(0, 5)
  .map((m) => `  ・score=${m.score} rank=${m.rank} (${m.reason}) → ${m.action} ${m.hours}h後`)
  .join("\n");

console.log(
  [
    "📊 ブリーフ編集会議（週次・自動集計・LLM不使用）",
    `観測: ${days}日分 / 成熟候補 ${candidates.length}（push ${g.pushed.n}・対照 ${g.control.n}）/ 行動 ${actions.length}件`,
    `push が${HOURS}h以内に触られた率: ${pct(g.pushed.strict, g.pushed.n)}（いつか: ${pct(g.pushed.loose, g.pushed.n)}）`,
    `対照（出さなかった側）: ${pct(g.control.strict, g.control.n)}（いつか: ${pct(g.control.loose, g.control.n)}）`,
    `リフト: strict ${pt(liftStrict)} / loose ${pt(liftLoose)}`,
    misses.length
      ? `見逃し（出さなかったのに行動された）${misses.length}件:\n${missLines}`
      : "見逃し: 0件",
    `提案: ${proposal}`,
    "※これは提案です。設定は何も変更していません（詳細解析: brief-lift.mjs）。",
  ].join("\n"),
);
