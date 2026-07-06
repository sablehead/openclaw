#!/bin/sh
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$STATE_DIR/openclaw.json"

mkdir -p "$STATE_DIR"

# fly-root-init.sh chowns $STATE_DIR to node:node before this script runs, so
# node always owns the file. Keep it 600: it contains the gateway auth token
# and plugin API keys, which must not be readable by other container users.
chmod 600 "$STATE_DIR/openclaw.json" 2>/dev/null || true

# Ensure required gateway.controlUi flags are always present.
# The dashboard may overwrite openclaw.json without these keys; re-apply on every start.
OPENCLAW_CONFIG_FILE="$CONFIG_FILE" node -e "
const fs = require('fs');
const path = process.env.OPENCLAW_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (_) {}
}
cfg.gateway = cfg.gateway || {};
cfg.gateway.controlUi = cfg.gateway.controlUi || {};
// Explicit origin allowlist instead of the dangerous Host-header fallback:
// the public URL is fixed, so there is no reason to trust arbitrary Hosts.
cfg.gateway.controlUi.allowedOrigins = ['https://sableshedwig.fly.dev'];
delete cfg.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback;
// Device auth re-enabled: remove the dangerous override so the secure default
// (per-browser device pairing) applies and clears any persisted true value.
delete cfg.gateway.controlUi.dangerouslyDisableDeviceAuth;
cfg.gateway.trustedProxies = ['172.16.0.0/12'];
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.workspace = '/data/workspace';
cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries['active-memory'] = cfg.plugins.entries['active-memory'] || {};
cfg.plugins.entries['active-memory'].enabled = true;
cfg.plugins.entries['active-memory'].config = cfg.plugins.entries['active-memory'].config || {};
cfg.plugins.entries['active-memory'].config.agents = ['main'];
cfg.plugins.entries['active-memory'].config.allowedChatTypes = ['direct'];
cfg.plugins.entries['active-memory'].config.queryMode = 'recent';
cfg.plugins.entries['active-memory'].config.promptStyle = 'balanced';
cfg.plugins.entries['active-memory'].config.timeoutMs = 15000;
cfg.plugins.entries['active-memory'].config.maxSummaryChars = 300;
cfg.skills = cfg.skills || {};
cfg.skills.entries = cfg.skills.entries || {};
cfg.skills.entries['coding-agent'] = cfg.skills.entries['coding-agent'] || {};
cfg.skills.entries['coding-agent'].enabled = true;
cfg.tools = cfg.tools || {};
cfg.tools.allow = cfg.tools.allow || [];
if (!cfg.tools.allow.includes('web_fetch')) cfg.tools.allow.push('web_fetch');
if (!cfg.tools.allow.includes('write')) cfg.tools.allow.push('write');
if (!cfg.tools.allow.includes('web_search')) cfg.tools.allow.push('web_search');
// Telegram is the proactive-push channel (notifications fire; the WhatsApp
// self-chat does not). Token comes from the TELEGRAM_BOT_TOKEN secret; owner
// allowFrom / pairing stays in /data so personal IDs never land in this public repo.
cfg.channels = cfg.channels || {};
cfg.channels.telegram = cfg.channels.telegram || {};
cfg.channels.telegram.enabled = true;
cfg.channels.telegram.dmPolicy = cfg.channels.telegram.dmPolicy || 'pairing';
cfg.channels.telegram.actions = cfg.channels.telegram.actions || {};
cfg.channels.telegram.actions.sendMessage = true;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
"

# Write Brave Search API key to config if provided via Fly.io secret.
if [ -n "$BRAVE_API_KEY" ]; then
  OPENCLAW_CONFIG_FILE="$CONFIG_FILE" BRAVE_KEY="$BRAVE_API_KEY" node -e "
const fs = require('fs');
const path = process.env.OPENCLAW_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (_) {}
}
cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries.brave = cfg.plugins.entries.brave || {};
cfg.plugins.entries.brave.enabled = true;
cfg.plugins.entries.acpx = cfg.plugins.entries.acpx || {};
cfg.plugins.entries.acpx.enabled = false;
cfg.plugins.entries.brave.config = cfg.plugins.entries.brave.config || {};
cfg.plugins.entries.brave.config.webSearch = cfg.plugins.entries.brave.config.webSearch || {};
cfg.plugins.entries.brave.config.webSearch.apiKey = process.env.BRAVE_KEY;
cfg.tools = cfg.tools || {};
cfg.tools.web = cfg.tools.web || {};
cfg.tools.web.search = cfg.tools.web.search || {};
cfg.tools.web.search.provider = 'brave';
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
"
fi

# Enable the voice-call plugin (Twilio) when call credentials are provided.
# Inert until TWILIO_* secrets are set, mirroring the other secret-gated blocks.
# Twilio reaches the gateway only over the public 443->3000 path, which serves
# the Control UI, not the voice-call webhook. The plugin runs its own listener
# (serve.port=3334), exposed publicly on 8443 by the second fly.toml service.
# Bind 0.0.0.0 so the Fly proxy can reach 3334 (the schema default 127.0.0.1
# is loopback-only and unreachable from the proxy).
if [ -n "$TWILIO_ACCOUNT_SID" ] && [ -n "$TWILIO_AUTH_TOKEN" ] && [ -n "$TWILIO_FROM_NUMBER" ]; then
  OPENCLAW_CONFIG_FILE="$CONFIG_FILE" \
  VC_SID="$TWILIO_ACCOUNT_SID" \
  VC_TOKEN="$TWILIO_AUTH_TOKEN" \
  VC_FROM="$TWILIO_FROM_NUMBER" \
  VC_TO="${VOICE_CALL_TO_NUMBER}" \
  VC_ALLOW_FROM="${VOICE_CALL_ALLOW_FROM}" \
  node -e "
const fs = require('fs');
const path = process.env.OPENCLAW_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (_) {}
}
cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries['voice-call'] = cfg.plugins.entries['voice-call'] || {};
const vc = cfg.plugins.entries['voice-call'];
vc.enabled = true;
vc.config = vc.config || {};
const c = vc.config;
c.provider = 'twilio';
c.twilio = c.twilio || {};
c.twilio.accountSid = process.env.VC_SID;
c.twilio.authToken = process.env.VC_TOKEN;
c.fromNumber = process.env.VC_FROM;
if (process.env.VC_TO) { c.toNumber = process.env.VC_TO; }
// Plugin webhook listener (separate from the gateway). 0.0.0.0 so the Fly proxy
// can forward external 8443 -> internal 3334.
c.serve = { port: 3334, bind: '0.0.0.0', path: '/voice/webhook' };
// Explicit public URL Twilio uses for signing; the :8443 port variant is handled
// by voice-call's port-tolerant Twilio signature check.
c.publicUrl = 'https://sableshedwig.fly.dev:8443/voice/webhook';
c.outbound = c.outbound || {};
c.outbound.defaultMode = 'notify';
// The notify auto-hangup timer starts when TTS playback is *initiated* (Twilio
// accepts the <Say> TwiML), not when audio finishes, so the 3s schema default
// cut our ~6s test message off mid-sentence. 20s covers typical 1-2 sentence
// notifications; Twilio bills per started minute so a longer window is free.
c.outbound.notifyHangupDelaySec = 20;
// Japanese: ja-JP drives <Gather> ASR + <Say> language; Polly.Mizuki gives a
// Japanese spoken voice (no OpenAI key needed — TTS provider is only constructed
// when streaming is enabled, which it is not here).
c.locale = 'ja-JP';
c.tts = c.tts || {};
c.tts.provider = 'openai';
c.tts.providers = c.tts.providers || {};
c.tts.providers.openai = Object.assign({}, c.tts.providers.openai, { voice: 'Polly.Mizuki' });
// Inbound (call Hedwig) is opt-in via a secret so personal numbers never land in
// this public repo. Without it, only outbound calls are allowed.
const allow = (process.env.VC_ALLOW_FROM || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
if (allow.length > 0) {
  c.inboundPolicy = 'allowlist';
  c.allowFrom = allow;
} else {
  c.inboundPolicy = 'disabled';
}
// tools.allow is a strict allowlist (Hedwig's base set is web_fetch/write/web_search),
// so the voice_call tool must be added explicitly or the model never sees it and
// replies that it cannot place calls.
cfg.tools = cfg.tools || {};
cfg.tools.allow = cfg.tools.allow || [];
if (!cfg.tools.allow.includes('voice_call')) { cfg.tools.allow.push('voice_call'); }
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
"
fi

# Enable the Hedwig proxy plugin (calendar_create write tool) when the proxy
# token is set. The tool POSTs to hedwig-cal with the token on the Authorization
# header (gateway-side), so creation no longer rides a web_fetch GET URL that
# would leak the token into request logs and the agent's session transcript.
if [ -n "$HEDWIG_CAL_TOKEN" ]; then
  OPENCLAW_CONFIG_FILE="$CONFIG_FILE" node -e "
const fs = require('fs');
const path = process.env.OPENCLAW_CONFIG_FILE;
let cfg = {};
if (fs.existsSync(path)) { try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (_) {} }
cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries['hedwig-proxy'] = cfg.plugins.entries['hedwig-proxy'] || {};
cfg.plugins.entries['hedwig-proxy'].enabled = true;
// Strict allowlist: the tool stays invisible to the model unless listed here.
cfg.tools = cfg.tools || {};
cfg.tools.allow = cfg.tools.allow || [];
if (!cfg.tools.allow.includes('calendar_create')) cfg.tools.allow.push('calendar_create');
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
"
fi

# Write Google API key to auth-profiles if provided via Fly.io secret.
# Use || true so a pre-existing root-owned file never blocks gateway startup.
if [ -n "$GOOGLE_API_KEY" ]; then
  OPENCLAW_STATE_DIR_VAL="$STATE_DIR" OPENCLAW_GOOGLE_KEY="$GOOGLE_API_KEY" node -e "
const fs = require('fs');
const dir = process.env.OPENCLAW_STATE_DIR_VAL + '/agents/main/agent';
fs.mkdirSync(dir, { recursive: true });
const file = dir + '/auth-profiles.json';
// Merge: profiles for other providers may have been added at runtime
// (e.g. via openclaw configure); overwriting would silently delete them.
let store = { version: 1, profiles: {} };
if (fs.existsSync(file)) {
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
}
store.profiles = store.profiles || {};
store.profiles['google:default'] = { type: 'api_key', provider: 'google', key: process.env.OPENCLAW_GOOGLE_KEY };
fs.writeFileSync(file, JSON.stringify(store, null, 2));
" || true
fi

# Write Google Calendar OAuth credentials to workspace if provided via Fly.io secrets.
if [ -n "$GOOGLE_CALENDAR_REFRESH_TOKEN" ]; then
  OPENCLAW_STATE_DIR_VAL="$STATE_DIR" \
  GC_CLIENT_ID="${GOOGLE_CALENDAR_CLIENT_ID}" \
  GC_CLIENT_SECRET="${GOOGLE_CALENDAR_CLIENT_SECRET}" \
  GC_REFRESH_TOKEN="${GOOGLE_CALENDAR_REFRESH_TOKEN}" \
  node -e "
const fs = require('fs');
const dir = process.env.OPENCLAW_STATE_DIR_VAL || '/data';
const wsDir = dir + '/workspace/credentials';
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(wsDir + '/google-calendar.json', JSON.stringify({
  client_id: process.env.GC_CLIENT_ID,
  client_secret: process.env.GC_CLIENT_SECRET,
  refresh_token: process.env.GC_REFRESH_TOKEN,
  token_uri: 'https://oauth2.googleapis.com/token'
}, null, 2));
" || true
fi

# Write himalaya config for Gmail OAuth2 if credentials are provided.
# If a manually curated config exists on the persistent volume, use that
# instead of generating one — avoids needing a full redeploy for config tweaks.
if [ -f /data/himalaya-config.toml ]; then
  mkdir -p /home/node/.config/himalaya
  cp /data/himalaya-config.toml /home/node/.config/himalaya/config.toml
  chown -R node:node /home/node/.config/himalaya 2>/dev/null || true
elif [ -n "$GOOGLE_GMAIL_REFRESH_TOKEN" ] && [ -n "$HIMALAYA_EMAIL" ]; then
  mkdir -p /home/node/.config/himalaya
  cat > /home/node/.config/himalaya/config.toml << HIMALAYA_EOF
[accounts.Gmail]
email = "${HIMALAYA_EMAIL}"
display-name = "${HIMALAYA_DISPLAY_NAME:-User}"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "${HIMALAYA_EMAIL}"

backend.auth.type = "oauth2"
backend.auth.method = "xoauth2"
backend.auth.client-id = "${GOOGLE_CALENDAR_CLIENT_ID}"
backend.auth.client-secret.raw = "${GOOGLE_CALENDAR_CLIENT_SECRET}"
backend.auth.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
backend.auth.token-url = "https://oauth2.googleapis.com/token"
backend.auth.access-token.raw = ""
backend.auth.refresh-token.raw = "${GOOGLE_GMAIL_REFRESH_TOKEN}"
backend.auth.pkce = false
backend.auth.scopes = ["https://mail.google.com/"]

folder.aliases.sent = "[Gmail]/送信済みメール"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "${HIMALAYA_EMAIL}"

message.send.backend.auth.type = "oauth2"
message.send.backend.auth.method = "xoauth2"
message.send.backend.auth.client-id = "${GOOGLE_CALENDAR_CLIENT_ID}"
message.send.backend.auth.client-secret.raw = "${GOOGLE_CALENDAR_CLIENT_SECRET}"
message.send.backend.auth.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
message.send.backend.auth.token-url = "https://oauth2.googleapis.com/token"
message.send.backend.auth.access-token.raw = ""
message.send.backend.auth.refresh-token.raw = "${GOOGLE_GMAIL_REFRESH_TOKEN}"
message.send.backend.auth.pkce = false
message.send.backend.auth.scopes = ["https://mail.google.com/"]
HIMALAYA_EOF
  chown -R node:node /home/node/.config/himalaya 2>/dev/null || true
fi

# Pre-populate workspace files so the bootstrap ritual is skipped on every cold start.
WORKSPACE_DIR="/data/workspace"
mkdir -p "$WORKSPACE_DIR"
mkdir -p "$WORKSPACE_DIR/memory"

# Persona source of truth = the private rulebook (version-controlled, reviewable),
# not this volume. SOUL.md (PII-free persona) comes from rulebook roles/hedwig.md;
# USER.md (PII) is injected from a secret so it never lands in git. The volume is a
# cache, not a single point of failure: we overwrite ONLY on a successful fetch, so a
# GitHub/network outage keeps the last-known-good copy instead of an empty persona.
# Repo id is a secret too, so this public file names neither the repo nor any content.
if [ -n "$HEDWIG_USER_PROFILE" ]; then
  printf '%s\n' "$HEDWIG_USER_PROFILE" > "$WORKSPACE_DIR/USER.md"
fi
# Objectives (owner's goals) are folded into USER.md: the runtime injects only a
# fixed set of workspace files (src/agents/workspace.ts), so a standalone
# OBJECTIVES.md would never reach the agent. The objectives store stays an
# independent source (its own secret + git repo, hedwig-objectives); killing the
# probe = unset HEDWIG_OBJECTIVES. Appended (>>) so it follows the profile.
if [ -n "$HEDWIG_OBJECTIVES" ]; then
  printf '\n%s\n' "$HEDWIG_OBJECTIVES" >> "$WORKSPACE_DIR/USER.md"
fi
if [ -n "$HEDWIG_RULEBOOK_REPO" ] && [ -n "$GITHUB_TOKEN" ]; then
  RB_DIR="$(mktemp -d)"
  if git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN}@github.com/${HEDWIG_RULEBOOK_REPO}.git" "$RB_DIR" >/dev/null 2>&1 \
     && [ -f "$RB_DIR/roles/hedwig.md" ]; then
    # Strip the rulebook note's YAML frontmatter so SOUL.md is a clean persona prompt.
    awk 'NR==1 && $0=="---"{inf=1; next} inf && $0=="---"{inf=0; next} !inf' \
      "$RB_DIR/roles/hedwig.md" > "$WORKSPACE_DIR/SOUL.md"
    # Identity is folded into SOUL.md now; drop the stale standalone file so the
    # runtime doesn't inject a second, older identity alongside it.
    rm -f "$WORKSPACE_DIR/IDENTITY.md"
    echo "fly-start: persona SOUL.md sourced from rulebook"
  else
    echo "fly-start: rulebook fetch failed; keeping last-known-good persona on volume"
  fi
  rm -rf "$RB_DIR"
fi
for f in USER.md SOUL.md; do
  [ -f "$WORKSPACE_DIR/$f" ] || echo "⚠️  $WORKSPACE_DIR/$f missing (no secret/rulebook and no volume copy)."
done

# MEMORY.md — long-term memory (create only if not exists; never overwrite)
if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
  cat > "$WORKSPACE_DIR/MEMORY.md" << 'MEMORY'
# Memory

MEMORY
fi

# TOOLS.md — available APIs and tools
cat > "$WORKSPACE_DIR/TOOLS.md" << TOOLSEOF
# Tools

## 共通ルール（すべてのツール・API）
- ツールやAPIを実行したら、必ず実際の応答（JSON・ツールの実行結果）を読んでから報告する。実行結果を見ずに「やった」「登録した」「電話した」と推測で言わない。
- 応答に「そのまま伝える用の文」（予定作成の report、天気の line など）が含まれていたら、その文を一字一句そのまま使う。自分で言い換えたり成否を補ったりしない。
- そういう文が無い場合も、報告は応答に実在するフィールドだけを根拠にする。error フィールド・HTTPエラー・成功フラグ無しのときは、成功扱いにせず正直に「できませんでした」と伝える。

## 天気・傘（/weather）

天気・気温・傘の要否を聞かれたら、以下のエンドポイントを web_fetch で呼び出す（GETのみ）。web_search（Brave等）で天気を判断しない。

エンドポイント: https://hedwig-cal.fly.dev/weather
必須パラメーター: token=${HEDWIG_CAL_TOKEN}
任意パラメーター: day=today または day=tomorrow（省略すると tomorrow）。対応はこの2日のみ。

例: https://hedwig-cal.fly.dev/weather?day=tomorrow&token=${HEDWIG_CAL_TOKEN}

レスポンス（JSON）:
- line: 天気・最高/最低気温・傘の要否をまとめた確定の一文。共通ルールの通り、この line を一字一句そのまま転記する。言い換えたり傘の要否を自分で判断し直したりしない。
- summary: 天気概況（晴れ/曇り/雨 など）
- tempMax / tempMin: 最高・最低気温（℃）
- umbrella: 傘が必要なら true（サーバが降水シンボル・積算降水量から確定済み）
- umbrellaText: 「傘を持って」または「傘は不要」

出典名（Yahoo などのサービス名）は名乗らない・勝手に作らない。today/tomorrow 以外の日付や、応答に無い数値は推測で答えず、わからないと正直に伝える。

## Google Calendar API

予定を確認するには以下のエンドポイントをweb_fetchで呼び出す（GETのみ）:

エンドポイント: https://hedwig-cal.fly.dev/events
必須パラメーター: token=${HEDWIG_CAL_TOKEN}
任意パラメーター: date=YYYY-MM-DD（省略すると今日のJST日付）

例: https://hedwig-cal.fly.dev/events?date=2026-04-25&token=${HEDWIG_CAL_TOKEN}

レスポンス（JSON）:
- count: イベント数（0なら予定なし）
- events[]: イベントのリスト
  - title: タイトル
  - start: 開始日時（allDay=falseなら ISO 8601 形式、trueなら YYYY-MM-DD）
  - end: 終了日時
  - location: 場所（null可）
  - description: 詳細（null可）
  - allDay: 終日イベントかどうか
  - colorId / color: 予定の色ID(1-11)と色名（予定の性質を表す。null可）
  - ongoing: 前日から続く多日予定なら true（「継続中」と畳んでよい）

時刻はJST（+09:00）で返ってくる。
「今日」「明日」などの質問は今日の日付（JST）を基準にdateパラメーターを指定すること。
任意の日付を指定でき、過去・未来どちらも取得できる。

予定を登録（作成）するには calendar_create ツールを使う（web_fetch の GET URL では作成しない。トークンはツールがサーバ側で付けるので渡さない）:

ツール: calendar_create
必須パラメーター: title=タイトル / start=開始
任意パラメーター: end=終了 / colorId=色(1-11) / location=場所 / desc=詳細 / allDay=true（終日）

start・endの形式: 時刻ありは YYYY-MM-DDTHH:MM（JST）、終日は YYYY-MM-DD。end省略時は開始の1時間後。
登録フォーマット（人もAIも後から性質を扱えるように必ず守る）:
- 色(colorId)で性質を表す。${HEDWIG_CALENDAR_COLOR_RULE}
- 場所は location に入れる（タイトルに混ぜない）。相手・内容は title に簡潔に。
- 時間が不明なら allDay=true にして「0分予定」を作らない。
- 補足は desc に「key: value」の短いタグ行で（任意度/締切/費用 など）。日付を含むタグ（締切など）は必ず YYYY-MM-DD 形式で書く（例: 締切: 2026-07-01）。

例: calendar_create を {title:"美容院", start:"2026-07-01T14:00", colorId:"8", location:"四条"} で呼ぶ。

ツールの実行結果（JSON）には report（確定した報告文）が入っている。共通ルールの通り、その report をそのまま伝えること（成否を自分で推測しない）。report が無い／失敗のときは成功扱いにせず「登録できませんでした」と正直に伝える。
同じ title・開始日時はサーバが重複を検知して既存の予定を返すので、二重登録の心配はない。

## Gmail 未読メール

未読メールを確認するには以下のエンドポイントをweb_fetchで呼び出す（GETのみ）:

エンドポイント: https://hedwig-cal.fly.dev/mail
必須パラメーター: token=${HEDWIG_CAL_TOKEN}
任意パラメーター: limit=件数（既定5、最大15）

例: https://hedwig-cal.fly.dev/mail?limit=5&token=${HEDWIG_CAL_TOKEN}

レスポンス（JSON）:
- count: 未読件数（0なら未読なし）
- messages[]: 未読メールのリスト。**score の高い順（重要そうな順）に並んでいる**
  - line: **ブリーフに出す確定文字列**。差出人「件名」・経過日・要返信 をサーバが組み立て済み（例: 田中「請求書の件」・3日前・要返信）
  - score: 重要度スコア。IMPORTANT/スター/個人宛で加点、更新通知・ニュースレター（配信停止リンク付き）で減点
  - from/subject/date/category/needsReply: line の内訳（参考用。中身は既に line に反映済み）

サーバ側で広告(Promotions)とSNS(Social)は既に除外済み。本文は返さない。トークンはカレンダーと同じ。
ブリーフで「気になる未読」を出すときは **score>=1 の上位2-3件**について、その message の `line` を**一字一句そのまま**列挙する。天気の line と同じく、要約・緊急度・件の中身の推測を足さない（snippet も出さない）。score>=1 が無ければ「重要な未読はなし（ニュースレター中心）」とだけ言う。

## Google Places API (New)

場所の検索（カフェ、レストラン、施設など）にはこのAPIを使う。

エンドポイント: https://places.googleapis.com/v1/places:searchText (POST)
APIキー: ${GOOGLE_PLACES_API_KEY}

リクエストヘッダー:
- Content-Type: application/json
- X-Goog-Api-Key: ${GOOGLE_PLACES_API_KEY}
- X-Goog-FieldMask: places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.regularOpeningHours

リクエストボディ（JSON）:
{
  "textQuery": "検索クエリ（例: 京都駅 カフェ）",
  "languageCode": "ja",
  "maxResultCount": 5
}

レスポンスの読み方:
- places[].displayName.text: 店名
- places[].formattedAddress: 住所
- places[].rating: 評価（5点満点）
- places[].userRatingCount: レビュー数
- places[].regularOpeningHours.openNow: 今営業中かどうか

## 電話発信（voice_call ツール）

あなたは voice_call ツールで実際に電話をかけられます。これは比喩ではなく本物の発信機能です。
**現在は「通知（notify）専用モード」で運用しているため、メッセージを一度読み上げたら自動で電話が切れます。会話を続けることはできません。**

ユーザーが「電話して」「電話かけて」「電話で教えて」「電話ちょうだい」などと言ったら、
必ず voice_call ツールを action="initiate_call" で呼ぶこと。

- message: 電話がつながったら読み上げる内容（通知したいこと）を日本語で入れる
- to: 省略すると既定の番号（ユーザーの携帯）にかかる。別の番号なら E.164 形式で指定
- mode: ツール引数に mode がある場合は必ず "notify" を指定すること

会話を続ける（continue_call）機能は現在使えません。「私はAIなので電話できません」と断ってはいけない。あなたは実際に発信できる。

発信後の報告は冒頭の「共通ルール」に従う（ツールの実行結果を読んでから、成功時のみ「電話しました」、失敗なら「電話できませんでした」と正直に）。

## 蔵書（library）への取り込み依頼

「蔵書:」で始まるメッセージは、sable が蔵書（library・知識ストア）に残したい知識です（例:「蔵書: <URL>」「蔵書: 〇〇の手続きは△△」）。
あなたは蔵書に保存する手段をまだ持っていません。だから自分で保存しようとしない・記憶（メモリ）に書き込まない・「保存しました」「覚えました」と言わない。
代わりに、受け取ったことと「取り込みは司書が後で行う」ことだけを正直に短く伝える（例:「承知しました。司書が後で蔵書に取り込みます」）。内容の要約や感想は足さなくてよい。

## 目的（私の狙い）と注記
USER.md の末尾に「私の目的（Objectives）」がある（各行 = id | 期限 | status | 内容）。これは予定でも未読でもなく、項目を「私の今の狙いを前に進めるか」で見るための背骨。
- ブリーフで項目（予定・未読・締切など）を出すとき、その項目が **status: active の目的を明確に前へ進める**ものなら、その項目の行末に 〔狙い:<id>〕 を付ける（id は Objectives の id）。例:「7/3 面接カード指導 〔狙い:menseki〕」。
- 迷うもの・こじつけ・間接的なだけのものには付けない（付けないが既定・空＞こじつけ）。1項目に複数該当しても、最も中心の1つだけ。
- リストに無い狙いを新しく作らない。目的文以外の新しい事実を書かない。active 以外（done/abandoned/stalled）の目的には付けない。
- 目的は「並べ替えの参照軸」であって予定ではない。目的を calendar_create で登録したり、予定・未読として扱ったりしない。

## 壁打ち（判断支援）
「壁打ち:」で始まるメッセージ（全角「壁打ち：」も同じ）は、sable が「Xすべきか？」の判断を一緒に詰めてほしい合図。ふつうの相談と違い、次の型を必ず守る。これは **pull 専用**＝sable が「壁打ち:」と言ったときだけ。自分から壁打ちを始めない。
- **両側を本気で（中立要約は失格）**：賛成（やる）側の最強の論拠と、反対（やめる）側の最強の論拠を、それぞれ別々に、どちらも本気で立てる。「どちらも一理ある」で済ませない・片側だけにしない。出力はこの順・この見出しで：
  - 「◆ 賛成（最強）」… やる側の一番強い理由を数点。
  - 「◆ 反対（最強）」… やめる側の一番強い理由を数点。
  - 「⚖ 傾き」… 最後に **1行だけ**。USER.md の価値観と、末尾 Objectives の active な狙いに照らしてどちらへ傾くかを述べ、根拠にした狙いがあれば 〔狙い:<id>〕 で名指す。例:「⚖ 傾き：〔狙い:menseki〕を前に進める点で、やる側にやや傾く」。
- **接地は sable のもので（肝）**：一般論でなく、USER.md の価値観と Objectives の狙いを軸に論じる。ここを外すと「ただの雑談」になり価値が消える。
- **無いものは作らない（空＞捏造）**：USER.md／Objectives に無い価値観・狙いを新しく作らない。どの狙いにも明確に当てはまらないなら、⚖ 行で正直に「明確に該当する狙いは無い」と書く（こじつけの狙いを引かない・〔狙い:〕を無理に付けない）。論拠に使う世界の事実（統計・数値・日付など）で不確かなものは web_search で確かめるか、断定せず「要確認」と添える。作り話の数値を混ぜない。
- **副作用なし**：壁打ちは考えるだけ。この中で calendar_create や voice_call などのツールを勝手に呼ばない（sable が別に頼んだら別）。
TOOLSEOF

exec node openclaw.mjs gateway --allow-unconfigured --port "${PORT:-3000}" --bind lan
