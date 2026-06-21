#!/usr/bin/env node
// Brief quality SENTINEL (Gateway command cron, deterministic, no LLM = ¥0).
//
// Failed cron runs are already covered by the Cron Failure Alert. This closes the
// gap it cannot see: runs that finish status:ok but whose delivered summary
// silently degraded. Three checks, all calibrated against real run-log data
// (measured 2026-06-21 over 29 historical brief runs):
//   1. empty/thin   — summary missing or < MIN_CHARS. (Healthy briefs were
//                      190–495 chars; 0 thin in history. Floor is a cheap
//                      backstop for the catastrophic-empty case.)
//   2. degradation  — failure/refusal language ("…の取得に失敗しました" etc.).
//                      2 real hits in history: weather-section fetch failures the
//                      status:ok masked. 0 false hits on the 27 healthy runs.
//   3. token leak   — the proxy token (HEDWIG_CAL_TOKEN) or a token=/long-opaque
//                      string echoed into the delivered text. 0 in history; kept
//                      as a security tripwire (a smoke detector fires rarely).
//
// On anomaly: one Telegram DM to the owner. Healthy briefs stay silent. The
// brief is delivered BEFORE this runs, so this is detection, not prevention:
// for degradation "don't trust this brief", for a leak "rotate the token now".
//
// Why a command cron (node), not an agent: deterministic, no confabulation, free,
// and it reaches the cron run-log via the CLI which the briefs' isolated agents
// cannot. Reads the live run-log via `cron runs`; never persists anything.
//
// Env: TELEGRAM_BOT_TOKEN + owner id (from config commands.ownerAllowFrom),
// HEDWIG_CAL_TOKEN|CAL_PROXY_TOKEN (exact-token leak check),
// BRIEF_SENTINEL_DRYRUN=1 (print instead of DM), BRIEF_SENTINEL_MIN_CHARS (80),
// BRIEF_SENTINEL_WINDOW_MIN (90), BRIEF_SENTINEL_IDS ("name:id,name:id").
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const OPENCLAW =
  process.env.BRIEF_SENTINEL_OPENCLAW || new URL("../openclaw.mjs", import.meta.url).pathname;
const MIN_CHARS = Number(process.env.BRIEF_SENTINEL_MIN_CHARS || 80);
const WINDOW_MS = Number(process.env.BRIEF_SENTINEL_WINDOW_MIN || 90) * 60_000;
const DRYRUN = process.env.BRIEF_SENTINEL_DRYRUN === "1";
const TOKEN = process.env.HEDWIG_CAL_TOKEN || process.env.CAL_PROXY_TOKEN || "";
const log = (m) => console.log(`brief-sentinel: ${m}`);

// label:id pairs. Defaults are the live Morning/Evening brief ids.
const BRIEFS = (
  process.env.BRIEF_SENTINEL_IDS ||
  "朝ブリーフ:b0f26c87-d537-44cb-943f-ca3575c14d89,夕ブリーフ:5ae4aecb-2ebd-44ad-b766-8f37324f1245"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(":");
    return { label: s.slice(0, i), id: s.slice(i + 1) };
  });

// Failure/refusal language. Deliberately NOT content-absence: a brief that
// legitimately says "要対応の未読なし" is healthy and must not trip. Validated:
// 0 hits on 27 healthy runs, 2 hits on the real weather-failure runs.
const errRe =
  /取得できません|取得に失敗|失敗しました|エラーが発生|エラーになりました|アクセスできません|問題が発生|データを取得できま|情報を取得できま|応答がありません|as an AI|I (cannot|can.?t|am unable)|I.?m sorry|something went wrong/i;

// Scrub anything token-shaped before any context is shown in an alert.
function scrub(s) {
  let t = s;
  if (TOKEN) t = t.split(TOKEN).join("<TOK>");
  t = t.replace(/([?&](?:token|key|apikey)=)[^&\s"]*/gi, "$1<TOK>");
  t = t.replace(/[A-Za-z0-9_\-]{24,}/g, "<OPAQUE>");
  return t;
}

function leakKind(s) {
  if (TOKEN && s.includes(TOKEN)) return "proxy-token";
  if (/[?&](token|key|apikey)=/i.test(s)) return "query-param";
  const m = s.match(/[A-Za-z0-9_\-]{24,}/g);
  if (m && m.some((x) => !/^https?$/i.test(x))) return "opaque-string";
  return "";
}

function latestRun(id) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [OPENCLAW, "cron", "runs", "--id", id, "--limit", "5"], {
      encoding: "utf8",
      maxBuffer: 2e7,
      env: { ...process.env, OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT || "3000" },
    });
  } catch (e) {
    log(`cron runs failed for ${id}: ${String(e.message).slice(0, 120)}`);
    return null;
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const entries = Array.isArray(data) ? data : data.entries || [];
  // Newest run within the window; ignore stale/manual runs so we never re-alert.
  const cutoff = Date.now() - WINDOW_MS;
  const recent = entries
    .filter((e) => typeof e.runAtMs === "number" && e.runAtMs >= cutoff)
    .sort((a, b) => b.runAtMs - a.runAtMs);
  return recent[0] || null;
}

// --- inspect the just-fired run of each brief ---
const anomalies = [];
for (const { label, id } of BRIEFS) {
  const run = latestRun(id);
  if (!run) continue; // no recent run for this brief at this hour — expected
  // Failed runs are owned by the Cron Failure Alert; we only judge "ok" runs.
  if (run.status !== "ok") continue;
  const s = typeof run.summary === "string" ? run.summary : "";
  const when = new Date(run.runAtMs).toISOString().slice(0, 16).replace("T", " ");
  const trimmed = s.trim();

  const leak = leakKind(s);
  if (leak) {
    // Never echo the leaked value; just flag for rotation.
    anomalies.push({
      label,
      when,
      kind: "leak",
      detail: `トークン様の文字列を検出 (${leak})。即ローテーション推奨。`,
    });
    continue; // a leak supersedes other checks for this run
  }
  if (trimmed.length < MIN_CHARS) {
    anomalies.push({
      label,
      when,
      kind: "thin",
      detail: `出力が異常に短い (${trimmed.length}字 / 通常190字以上)`,
    });
    continue;
  }
  const mm = s.match(errRe);
  if (mm) {
    const i = mm.index;
    const ctx = scrub(s.slice(Math.max(0, i - 25), i + 25)).replace(/\s+/g, " ");
    anomalies.push({
      label,
      when,
      kind: "degraded",
      detail: `区間失敗の兆候「${mm[0]}」: …${ctx}…`,
    });
  }
}

if (!anomalies.length) {
  log("all recent briefs healthy");
  process.exit(0);
}

const lines = anomalies.map((a) => `⚠️ ${a.label} ${a.when}\n  • ${a.detail}`);
const body =
  "🦉 ブリーフ品質アラート（自動検査・status:ok の裏で劣化）\n\n" +
  lines.join("\n\n") +
  "\n\n（失敗そのものは別の Failure Alert が通知します。これは成功扱いの劣化のみ。）";

if (DRYRUN) {
  log(`${anomalies.length} anomaly(ies) (dry-run, not sent):`);
  console.log(body);
  process.exit(0);
}

// --- alert the owner (direct Telegram, same path as mem-extract) ---
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
let chat = process.env.HEDWIG_OWNER_CHAT_ID || "";
if (!chat) {
  try {
    const cfg = JSON.parse(readFileSync(`${STATE}/openclaw.json`, "utf8"));
    const cand = []
      .concat(cfg.commands?.ownerAllowFrom || [], cfg.commands?.allowFrom || [])
      .map(String);
    const hit = cand.find((x) => /(^|:)telegram:?\d+$/i.test(x) || /^\d+$/.test(x));
    if (hit) chat = hit.replace(/.*?(\d+)$/, "$1");
  } catch {}
}
if (!tgToken || !chat) {
  log("no telegram token/owner id; anomalies not delivered");
  process.exit(0);
}
try {
  await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: body }),
  });
  log(`alerted owner: ${anomalies.length} anomaly(ies)`);
} catch (e) {
  log(`telegram alert failed: ${e.message}`);
}
