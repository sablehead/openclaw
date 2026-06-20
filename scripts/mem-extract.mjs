#!/usr/bin/env node
// Proactive memory extraction (Gateway command cron). Pulls durable personal facts
// the user stated in recent DIRECT chats into MEMORY.md, so memory fills passively
// instead of depending on the user saying "remember this".
//
// Why a command cron + direct model API (not an agent): the agent has no `read` tool
// and cannot reach past session transcripts; the system-prompt copy of MEMORY.md is
// truncated at bootstrapMaxChars. Shell/node reads the full files directly.
//
// Safety: APPEND-ONLY. It never rewrites existing MEMORY.md lines, so an extraction
// error can only add a stray fact, never delete real ones. A snapshot is taken first;
// exact-duplicate cleanup is the consolidation cron's job. Notifies the owner on
// Telegram ONLY when new facts were actually added.
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const WS = `${STATE}/workspace`;
const MEM = `${WS}/MEMORY.md`;
const ARCHIVE = `${WS}/.memory-archive`;
const SD = `${STATE}/agents/main/sessions`;
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const MODEL = process.env.MEM_EXTRACT_MODEL || "gemini-2.5-flash";
const WINDOW_DAYS = Number(process.env.MEM_EXTRACT_WINDOW_DAYS || 8);
const MAX_TURN_CHARS = 12000; // cap context fed to the model
const log = (m) => console.log(`mem-extract: ${m}`);
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST

if (!KEY) {
  log("no GEMINI/GOOGLE API key, skip");
  process.exit(0);
}
if (!existsSync(SD)) {
  log("no sessions dir, skip");
  process.exit(0);
}

// --- 1. collect recent user turns from non-brief (direct-chat) sessions ---
// Brief/cron sessions carry no personal facts; skip them by content marker to cut cost.
const briefRe = /傘|未読メール|明日の予定|今日の予定|met\.no|降水|おはよう|mem-consolidate/;
const cutoff = Date.now() - WINDOW_DAYS * 86400000;
const turns = [];
for (const f of readdirSync(SD)) {
  if (!f.endsWith(".jsonl") || f.includes("trajectory")) continue;
  let st;
  try {
    st = statSync(`${SD}/${f}`);
  } catch {
    continue;
  }
  if (st.mtimeMs < cutoff) continue;
  let txt;
  try {
    txt = readFileSync(`${SD}/${f}`, "utf8");
  } catch {
    continue;
  }
  if (briefRe.test(txt)) continue;
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "message" || o.message?.role !== "user") continue;
    const c = o.message.content;
    const blocks = Array.isArray(c) ? c : [c];
    for (const b of blocks) {
      const t = typeof b === "string" ? b : b?.text;
      if (t && typeof t === "string") turns.push(t.trim());
    }
  }
}
if (!turns.length) {
  log("no recent direct-chat user turns, skip");
  process.exit(0);
}
const turnsText = turns.join("\n---\n").slice(0, MAX_TURN_CHARS);

// --- 2. current memory (full file, untruncated) ---
let memText = "";
try {
  memText = readFileSync(MEM, "utf8");
} catch {}

// --- 3. extract NEW durable facts via the model (strict, no inference) ---
const prompt = `あなたはユーザー本人の個人アシスタントの「記憶係」です。下記【最近の会話のユーザー発言】から、長期的に覚える価値のある「ユーザー本人についての持続的な事実」だけを抽出してください。

厳格なルール（違反厳禁）:
- ユーザーが明示的に述べた事実のみ。推測・憶測・補完・創作は一切しない。確証が無ければ出さない。
- 一過性の情報（その日の天気/予定/単発の依頼や質問）は除外。持続する属性・好み・人間関係・習慣・所属・健康などのみ。
- 【現在の記憶】に既にある事実は出さない（重複禁止）。
- 発言に無い情報を足さない。該当が無ければ「何も出力しない」（空）。
- 出力は1行1事実の箇条書きのみ。前置き・説明・コードブロックを付けない。
- 形式: - [カテゴリ] 内容（出典: 本人・${today}）

【現在の記憶】
${memText || "(空)"}

【最近の会話のユーザー発言】
${turnsText}`;

const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
let respText = "";
try {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 800 },
    }),
  });
  const data = await r.json();
  if (data.error) {
    log(`model error: ${JSON.stringify(data.error).slice(0, 160)}`);
    process.exit(0);
  }
  respText = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
} catch (e) {
  log(`fetch failed: ${e.message}`);
  process.exit(0);
}

// Keep only well-formed fact bullets; drop anything the model added around them.
const facts = respText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- ") && l.length > 4)
  // Defense in depth against re-adding something already present verbatim.
  .filter((l) => !memText.includes(l));
if (!facts.length) {
  log("no new durable facts");
  process.exit(0);
}

// --- 4. snapshot, then APPEND (never rewrite) ---
mkdirSync(ARCHIVE, { recursive: true });
if (memText) copyFileSync(MEM, `${ARCHIVE}/MEMORY-${today}-preextract.md`);
const base = memText.replace(/\s*$/, "");
const next = (base ? base + "\n" : "# Memory\n\n") + facts.join("\n") + "\n";
writeFileSync(MEM, next);
log(`appended ${facts.length} new fact(s)`);

// --- 5. notify owner ONLY when new facts were added ---
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
let chat = process.env.HEDWIG_OWNER_CHAT_ID || "";
if (!chat) {
  // Reuse the owner id already configured for command/cron delivery; never hard-coded
  // here (this script lives in the public fork). Shape is like "telegram:<id>".
  try {
    const cfg = JSON.parse(readFileSync(`${STATE}/openclaw.json`, "utf8"));
    const cand = []
      .concat(cfg.commands?.ownerAllowFrom || [], cfg.commands?.allowFrom || [])
      .map(String);
    const hit = cand.find((x) => /(^|:)telegram:?\d+$/i.test(x) || /^\d+$/.test(x));
    if (hit) chat = hit.replace(/.*?(\d+)$/, "$1");
  } catch {}
}
if (tgToken && chat) {
  const body = "🦉 今週あなたについて新しく覚えました:\n" + facts.join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: body, disable_notification: false }),
    });
    log("owner notified on telegram");
  } catch (e) {
    log(`telegram notify failed: ${e.message}`);
  }
} else {
  log("no telegram token/owner id, skipped notify");
}
