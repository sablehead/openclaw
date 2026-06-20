#!/usr/bin/env node
// Proactive memory SUGGESTER (Gateway command cron), propose-review model.
// Scans recent DIRECT chats for durable personal facts the user disclosed and DMs them
// to the owner as CANDIDATES. It NEVER writes MEMORY.md — saving happens only when the
// owner replies "覚えて: <fact>", which goes through the agent's normal (proven) write
// path. This eliminates the auto-write failure mode where the model invented a sensitive
// fact ("has a girlfriend") by over-inferring from a calendar event ("movie date with her").
//
// Why command cron + direct model API: the agent has no `read` tool and cannot reach past
// session transcripts; node reads the full files directly.
//
// Env: GEMINI_API_KEY|GOOGLE_API_KEY (model), TELEGRAM_BOT_TOKEN + owner id (from config),
// MEM_SUGGEST_DRYRUN=1 to print candidates instead of DMing, MEM_EXTRACT_MODEL,
// MEM_EXTRACT_WINDOW_DAYS.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";

const STATE = process.env.OPENCLAW_STATE_DIR || "/data";
const MEM = `${STATE}/workspace/MEMORY.md`;
const SD = `${STATE}/agents/main/sessions`;
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const MODEL = process.env.MEM_EXTRACT_MODEL || "gemini-2.5-flash";
const WINDOW_DAYS = Number(process.env.MEM_EXTRACT_WINDOW_DAYS || 8);
const DRYRUN = process.env.MEM_SUGGEST_DRYRUN === "1";
const MAX_TURN_CHARS = 12000;
const log = (m) => console.log(`mem-suggest: ${m}`);

if (!KEY) {
  log("no GEMINI/GOOGLE API key, skip");
  process.exit(0);
}
if (!existsSync(SD)) {
  log("no sessions dir, skip");
  process.exit(0);
}

// --- 1. recent direct-chat user turns (skip brief/maintenance/transactional sessions) ---
// Transactional sessions (calendar registration, tool/command requests) are the user
// asking Hedwig to DO something, not disclosing facts — and the model over-infers facts
// from their contents (e.g. "register a movie date with 彼女" -> "has a girlfriend").
// Exclude them at the source; genuine disclosure can always be saved via "覚えて:".
const skipRe =
  /傘|未読メール|明日の予定|今日の予定|met\.no|降水|おはよう|mem-consolidate|mem-suggest|登録して|削除して|更新して|events\/create|TOOLS\.md|web_fetch|\/mail|\/events/;
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
  if (skipRe.test(txt)) continue;
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
    for (const b of Array.isArray(c) ? c : [c]) {
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

let memText = "";
try {
  memText = readFileSync(MEM, "utf8");
} catch {}

// --- 2. propose candidates (strict; the model must NOT infer facts from tasks/events) ---
const prompt = `あなたはユーザー本人の個人アシスタントの記憶補助です。下記【最近の会話のユーザー発言】から、長期的に覚える価値のある「ユーザー本人についての持続的な事実」の候補を挙げてください。これは候補提案で、保存はユーザー承認後に行われます。保存はしません。

絶対の制約:
- ユーザーが会話の中で自分自身について明示的に述べた「自己開示」だけを候補にする。
- 次は候補にしない（最重要）: 予定/イベントの説明、登録・作成・削除・タスクの依頼内容、例示・テスト、ユーザーが「〜して」と指示した中身。これらは事実ではなく作業対象。
  例: 「『映画デート』彼女との予定を登録して」は予定登録の依頼であって「彼女がいる」という事実ではない。こうした推論は禁止。
- 推測・補完・創作は一切禁止。発言に直接書かれていないことは出さない。確証が無ければ出さない。
- 一過性情報（その日の天気/単発の予定/質問）は除外。持続する属性・好み・人間関係・習慣・所属・健康のみ。
- 【現在の記憶】に既にあるものは出さない。
- 出力は1行1候補の箇条書きのみ（前置き・説明・コードブロックなし）。形式: - [カテゴリ] 内容
- 該当が無ければ何も出力しない（空）。

【現在の記憶】
${memText || "(空)"}

【最近の会話のユーザー発言】
${turnsText}`;

let respText = "";
try {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 800 },
      }),
    },
  );
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

const candidates = respText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- ") && l.length > 4)
  .filter((l) => !memText.includes(l.replace(/^-\s*/, "")));
if (!candidates.length) {
  log("no new candidates");
  process.exit(0);
}

if (DRYRUN) {
  log(`${candidates.length} candidate(s) (dry-run, not sent):`);
  console.log(candidates.join("\n"));
  process.exit(0);
}

// --- 3. propose to owner; NEVER writes memory. Owner saves via "覚えて: <fact>". ---
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
  log("no telegram token/owner id; candidates not delivered");
  process.exit(0);
}

const body =
  "🦉 最近の会話から、覚えておくと良さそうな候補です（まだ保存していません）。\n" +
  "正しいものがあれば「覚えて: 〈内容〉」と返信してください。違うものは無視でOKです:\n\n" +
  candidates.join("\n") +
  "\n\n（例: 「覚えて: 京都の大学生」）";
try {
  await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: body }),
  });
  log(`proposed ${candidates.length} candidate(s) to owner`);
} catch (e) {
  log(`telegram propose failed: ${e.message}`);
}
