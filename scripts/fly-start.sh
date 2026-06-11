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
c.outbound.defaultMode = 'conversation';
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

# Workspace files: only create if not already on the persistent volume.
# Personal details (name, location, schedule, behaviour rules) live on the
# server only — never committed to the public repo.
for f in IDENTITY.md USER.md SOUL.md; do
  if [ ! -f "$WORKSPACE_DIR/$f" ]; then
    echo "⚠️  $WORKSPACE_DIR/$f not found. Create it manually on the server."
  fi
done

# MEMORY.md — long-term memory (create only if not exists; never overwrite)
if [ ! -f "$WORKSPACE_DIR/MEMORY.md" ]; then
  cat > "$WORKSPACE_DIR/MEMORY.md" << 'MEMORY'
# Memory

MEMORY
fi

# TOOLS.md — available APIs and tools
YAHOO_APPID="${YAHOO_APP_ID}"
cat > "$WORKSPACE_DIR/TOOLS.md" << TOOLSEOF
# Tools

## Yahoo! 気象情報API（日本の雨量・降水予報）
雨が降っているか、傘が必要かを聞かれたらこのAPIを使う。
※このAPIが返すのは降水強度（mm/h）のみ。気温・天気（晴れ/曇り）は返さない。

エンドポイント: https://map.yahooapis.jp/weather/V1/place
appid: $YAHOO_APPID
必須パラメーター: coordinates=経度,緯度（経度が先）、output=json

主要都市の座標（経度,緯度）:
- 大阪: 135.5023,34.6937
- 東京: 139.6917,35.6895
- 福岡: 130.4017,33.5902
- 札幌: 141.3468,43.0642
- 名古屋: 136.9066,35.1815
- 京都: 135.7556,35.0116

URLの例（大阪）:
https://map.yahooapis.jp/weather/V1/place?coordinates=135.5023,34.6937&output=json&appid=$YAHOO_APPID

レスポンスの読み方:
- Weather[].Type = "observation" → 現在の実測値
- Weather[].Type = "forecast" → 予測値（10分ごと、最大60分先）
- Weather[].Rainfall = 降水強度（mm/h）。0.0なら雨なし。

## 天気全般（気温・天気概況）
気温や「晴れ/曲り/雨」などの一般的な天気はBrave Searchで検索すること。

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

時刻はJST（+09:00）で返ってくる。
「今日」「明日」などの質問は今日の日付（JST）を基準にdateパラメーターを指定すること。
任意の日付を指定でき、過去・未来どちらも取得できる。

## Gmail 未読メール

未読メールを確認するには以下のエンドポイントをweb_fetchで呼び出す（GETのみ）:

エンドポイント: https://hedwig-cal.fly.dev/mail
必須パラメーター: token=${HEDWIG_CAL_TOKEN}
任意パラメーター: limit=件数（既定5、最大15）

例: https://hedwig-cal.fly.dev/mail?limit=5&token=${HEDWIG_CAL_TOKEN}

レスポンス（JSON）:
- count: 未読件数（0なら未読なし）
- messages[]: 未読メールのリスト
  - from: 差出人
  - subject: 件名
  - date: 受信日時

受信箱(INBOX)の未読のみ。本文は返さず件名・差出人・日時だけ。トークンはカレンダーと同じ。

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
TOOLSEOF

exec node openclaw.mjs gateway --allow-unconfigured --port "${PORT:-3000}" --bind lan
