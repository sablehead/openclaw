#!/usr/bin/env node
// Monthly routing cost watch (gateway command cron, deterministic, no LLM = ¥0).
//
// Promotes the manual monthly reconciliation (checkpoint routing-cost-watch-8-07)
// into an unattended line. The A1 tier-routing (memo project_hedwig_model_routing_eval,
// SHIPPED 2026-07-07) sends the 2 brief crons to gemini-3.1-pro-preview and leaves
// everything else on flash; the expected surcharge was +~$3.9/mo (¥590-780). This
// cron measures the real surcharge and checks it stayed in band.
//
// Source: /data/agents/main/sessions/*.trajectory.jsonl `model.completed` events —
// PII-free, top-level {ts, modelId, data.usage:{input,output,cacheRead,total}}, one
// per model run. The google runtime leaves the per-message `cost` at 0, so cost is
// computed from tokens x rates (same method as the A1 cost gate).
//
// Scope = the routing surcharge only. Pro is used by the brief crons alone, so the
// number is pro's actual cost minus what those same tokens would have cost on flash.
// Everything is normalized by PRO's own active span (its own min/max ts), never the
// global span across all models — the trajectory logs retain ~29 days of flash but
// pro is only days old, so dividing pro cost by the global span understates its
// monthly rate ~13x. Non-priced models (older flash, flash-lite from evals) never
// enter the surcharge, so no rate guessing is needed for them.
//
// Always speaks ONE report (owner is watching this cost line; monthly cadence is not
// noise, and always-speaking gives the "meter is being read" assurance a silent
// sentinel cannot). Verdicts: within band -> confirmation; over ceiling -> alarm +
// rollback command; any runs but zero pro -> routing silently reverted to flash;
// pro too young -> gathering. Never prints NO_REPLY, so there is no announce-
// suppression edge case — but keep `2>/dev/null` on the cron command anyway so no
// stderr can pollute the command summary.
//
// Env: OPENCLAW_STATE_DIR (/data), COST_WINDOW_DAYS (30, retention-bounded trailing
// window), COST_CEILING_USD (8 = ~2x the +$3.9/mo estimate), COST_MIN_SPAN_DAYS (5,
// data gate on pro's own span), COST_YEN_PER_USD (150).
import fs from "node:fs";
import path from "node:path";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const DIR = `${STATE}/agents/main/sessions`;
const WINDOW_DAYS = Number(process.env.COST_WINDOW_DAYS || 30);
const CEILING_USD = Number(process.env.COST_CEILING_USD || 8);
const MIN_SPAN_DAYS = Number(process.env.COST_MIN_SPAN_DAYS || 5);
const YEN = Number(process.env.COST_YEN_PER_USD || 150);

// per-1M-token USD rates (<=200K standard tier); cacheRead billed at 10% of input.
// Only the two models the routing decision is about: pro (the routed target) and the
// flash baseline it is priced against. Other models never touch the surcharge.
const RATES = {
  "gemini-3-flash-preview": { in: 0.5, out: 3.0, cache: 0.05 },
  "gemini-3.1-pro-preview": { in: 2.0, out: 12.0, cache: 0.2 },
};
const FLASH = "gemini-3-flash-preview";
const PRO = "gemini-3.1-pro-preview";
// brief cron ids (memo/HEDWIG-OPS): morning b0f26c87 / evening 5ae4aecb — pro-routed.
const BRIEF_CRONS = [
  "b0f26c87-d537-44cb-943f-ca3575c14d89",
  "5ae4aecb-2ebd-44ad-b766-8f37324f1245",
];

const usd = (u, r) =>
  ((u.input || 0) * r.in + (u.output || 0) * r.out + (u.cacheRead || 0) * r.cache) / 1e6;
const yen = (x) => Math.round(x * YEN);
const f2 = (x) => x.toFixed(2);

let files;
try {
  files = fs.readdirSync(DIR).filter((f) => f.endsWith(".trajectory.jsonl"));
} catch {
  console.log("💰 routing コスト watch: session ログ不在（集計不可）。");
  process.exit(0);
}

const since = Date.now() - WINDOW_DAYS * 86400_000;
let totalRuns = 0; // every model.completed in window (priced or not) — for the reverted check
const proRuns = []; // pro usage records, to measure pro's own span
const pro = { runs: 0, input: 0, output: 0, cacheRead: 0, usd: 0 };
for (const f of files) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(DIR, f), "utf8").split("\n");
  } catch {
    continue;
  }
  for (const ln of lines) {
    if (!ln) continue;
    let j;
    try {
      j = JSON.parse(ln);
    } catch {
      continue;
    }
    if (j.type !== "model.completed") continue;
    const ts = Date.parse(j.ts);
    if (!(ts >= since)) continue;
    const u = j.data && j.data.usage;
    if (!u) continue;
    totalRuns++;
    if (j.modelId !== PRO) continue;
    proRuns.push(ts);
    pro.runs++;
    pro.input += u.input || 0;
    pro.output += u.output || 0;
    pro.cacheRead += u.cacheRead || 0;
    pro.usd += usd(u, RATES[PRO]);
  }
}

// No usage at all = empty ledger (fresh redeploy / lost volume). Nothing to judge.
if (totalRuns === 0) {
  console.log(
    "💰 routing コスト watch: 窓内に model 実行なし（session ログ空）。蓄積を待って再評価。",
  );
  process.exit(0);
}

// Runs flowing but zero pro = the brief crons fell back to flash (bad rollback edit,
// allowlist drop, retired model id). The cost watch is the natural place to catch this.
if (pro.runs === 0) {
  console.log(
    [
      "💰 routing コスト watch",
      "⚠ 窓内に pro run ゼロ＝brief cron が flash に戻っている可能性。",
      `想定は朝夕 pro（${PRO}）。cron の model を確認: openclaw cron list --json で ${BRIEF_CRONS.join(" / ")}。`,
    ].join("\n"),
  );
  process.exit(0);
}

// Normalize by pro's OWN span, not the global one (see header). Monthly = per-day x 30.
const proSpanDays =
  proRuns.length > 1 ? (Math.max(...proRuns) - Math.min(...proRuns)) / 86400_000 : 0;
const surcharge = pro.usd - usd(pro, RATES[FLASH]); // vs the flash counterfactual
const perMonth = (x) => (proSpanDays > 0 ? (x / proSpanDays) * 30 : 0);

// Data gate: too young a pro history to project an honest monthly rate.
if (proSpanDays < MIN_SPAN_DAYS) {
  console.log(
    `💰 routing コスト watch（蓄積中）: pro 実績 ${pro.runs}run・span ${f2(proSpanDays)}日 < ${MIN_SPAN_DAYS}日。月次射影は次回に持ち越し。`,
  );
  process.exit(0);
}

const surchargeMo = perMonth(surcharge);
const proMo = perMonth(pro.usd);
const head = "💰 routing コスト watch（月次・自動集計・LLM不使用）";
const body =
  `pro 上乗せ ≈ $${f2(surchargeMo)}/月（¥${yen(surchargeMo)}）` +
  `｜pro実額 $${f2(proMo)}/月｜観測 pro ${pro.runs}run・${f2(proSpanDays)}日`;

if (surchargeMo > CEILING_USD) {
  console.log(
    [
      head,
      `⚠ ${body}`,
      `想定(+$3.9/月)の天井 $${CEILING_USD}/月 を超過。ロールバック＝brief 2本を flash へ:`,
      `  openclaw cron edit ${BRIEF_CRONS[0]} --model google/${FLASH}`,
      `  openclaw cron edit ${BRIEF_CRONS[1]} --model google/${FLASH}`,
    ].join("\n"),
  );
} else {
  console.log([head, `${body}｜想定(+$3.9/月)内 ✅`].join("\n"));
}
