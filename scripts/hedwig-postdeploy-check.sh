#!/bin/sh
# Hedwig post-deploy smoke gate. Read-only: never mutates the machine or config.
#
# Consolidates the manual `fly ssh` checks that HEDWIG-OPS.local.md lists for
# "デプロイ順③" into one fail-fast command. Run it right after
#   fly deploy --app sableshedwig --image registry.fly.io/sableshedwig:hedwig-<sha>
# A non-zero exit means a known deploy landmine fired (shadow fly-start.sh,
# dropped tool/plugin, TOOLS.md drift, dead port). The sentinel catches runtime
# degradation later; this catches the deploy itself before it goes live.
#
# Usage:  scripts/hedwig-postdeploy-check.sh [--wait] [--canary]
#   --wait   : poll the public gateway until it answers before asserting. Required
#              right after `fly deploy` (fly.toml has no [checks], so deploy returns
#              on "machine started" while the heavy image is still cold-booting).
#   --canary : also drive the LIVE agent through two confabulation probes (create +
#              weather), asserting it relays the proxy's server-confirmed string
#              verbatim. Opt-in because it costs ~2 gemini cron runs (a few yen) and
#              minutes; the default gate stays read-only and free. See the canary
#              block below.
# Env:    HEDWIG_APP (default sableshedwig), HEDWIG_HOST (default <app>.fly.dev)
set -eu

APP="${HEDWIG_APP:-sableshedwig}"
HOST="${HEDWIG_HOST:-${APP}.fly.dev}"
WAIT=0
CANARY=0
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=1;;
    --canary) CANARY=1;;
    *) echo "FATAL: unknown argument: $arg"; exit 2;;
  esac
done

# The CLI is `fly` locally but `flyctl` on the CI runner (setup-flyctl installs
# flyctl and the Deploy step calls `flyctl deploy`); accept either.
FLY=$(command -v fly || command -v flyctl || true)
[ -n "$FLY" ] || { echo "FATAL: fly/flyctl CLI not found on PATH"; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not found on PATH"; exit 2; }

# Single public-443 probe -> normalized http code (000 on connect failure).
probe_443() { curl -s --http1.1 -m 20 -o /dev/null -w '%{http_code}' "https://${HOST}/" 2>/dev/null || true; }
ready_code() { case "$1" in 2*|3*|401|403) return 0;; *) return 1;; esac; }

# --wait: cold-boot poll. Block until the gateway answers (any non-5xx) or give
# up after ~90s, then let the real checks run and grade the final state.
if [ "$WAIT" = "1" ]; then
  echo "-- waiting for gateway readiness (max ~90s) --"
  i=0
  while [ "$i" -lt 30 ]; do
    rc=$(probe_443); rc="${rc:-000}"
    if ready_code "$rc"; then echo "  ready: http $rc after ${i}x3s"; break; fi
    i=$((i+1)); sleep 3
  done
fi

fails=0
warns=0
# core check failed -> bump fail count; optional check failed -> warn only, so a
# rotated-out optional secret (voice/brave) does not block a healthy deploy.
core() { if [ "$1" = "0" ]; then printf 'PASS  %s\n' "$2"; else printf 'FAIL  %s  [%s]\n' "$2" "${3:-}"; fails=$((fails+1)); fi; }
opt()  { if [ "$1" = "0" ]; then printf 'PASS  %s\n' "$2"; else printf 'WARN  %s  [%s]\n' "$2" "${3:-}"; warns=$((warns+1)); fi; }

echo "== Hedwig post-deploy gate ($APP / $HOST) =="
echo
echo "-- public reachability (operator -> Fly proxy) --"

# Gateway / Control UI on 443->3000. Device auth may return 200 or a login page;
# a 5xx/connect failure means the gateway never came up. ready_code treats any
# 2xx/3xx/401/403 as up (see probe_443: --http1.1 per ops memo, HTTP/2 masks
# some proxy states).
code=$(probe_443); code="${code:-000}"
if ready_code "$code"; then core 0 "public:gateway-443  ($code)"; else core 1 "public:gateway-443" "http $code (5xx/000 = not ready)"; fi

# voice-call webhook on shared-IPv4 SNI port 8443->3334. Unsigned POST must 401
# (Twilio signature check). 000/5xx = listener missing or TLS route broken.
vcode=$(curl -s --http1.1 -m 25 -o /dev/null -w '%{http_code}' -X POST -d '{}' "https://${HOST}:8443/voice/webhook" || true)
vcode="${vcode:-000}"
case "$vcode" in
  401) opt 0 "public:voice-8443-401  ($vcode)";;
  *)   opt 1 "public:voice-8443-401" "http $vcode (expected 401)";;
esac

echo
echo "-- in-machine invariants (fly ssh -> node) --"

# Bundle every in-machine assertion into ONE node program piped over base64 so we
# pay a single ssh round-trip and dodge nested-quote hell. base64 exists on the
# VM (ops memo). Default ssh runs as root, which reads node-owned mode-600
# openclaw.json fine, so no `su node` dance is needed for read-only checks.
NODE_CHECK=$(cat <<'NODEJS'
const fs = require('fs');
const out = [];
const rec = (sev, name, ok, detail) => out.push({ sev, name, ok: !!ok, detail: detail || '' });

// Landmine No.1: a leftover /data/fly-start.sh override shadows the image copy
// forever (fly-root-init.sh prefers the volume copy until manually deleted).
rec('core', 'no-shadow-fly-start', !fs.existsSync('/data/fly-start.sh'),
  fs.existsSync('/data/fly-start.sh') ? 'present — rm it + restart' : '');

let cfg = null, cfgErr = '';
try { cfg = JSON.parse(fs.readFileSync('/data/openclaw.json', 'utf8')); }
catch (e) { cfgErr = String(e && e.message || e); }
rec('core', 'config-parses', !!cfg, cfgErr);

const allow = (cfg && cfg.tools && cfg.tools.allow) || [];
const pluginOn = (id) => !!(cfg && cfg.plugins && cfg.plugins.entries
  && cfg.plugins.entries[id] && cfg.plugins.entries[id].enabled);

// Base tool allowlist + the calendar write tool the proxy plugin ships. Missing
// here = "[agents/tool-policy] removed N tool(s)" and the model silently refuses.
for (const t of ['web_fetch', 'write', 'web_search', 'calendar_create', 'calendar_update'])
  rec('core', 'tools.allow:' + t, allow.includes(t), 'allow=[' + allow.join(',') + ']');
rec('core', 'plugin:hedwig-proxy', pluginOn('hedwig-proxy'));

// Optional surfaces gated on Fly secrets — warn, do not block.
rec('opt', 'tools.allow:voice_call', allow.includes('voice_call'));
rec('opt', 'plugin:voice-call', pluginOn('voice-call'));
rec('opt', 'plugin:brave', pluginOn('brave'));

let tools = '';
try { tools = fs.readFileSync('/data/workspace/TOOLS.md', 'utf8'); } catch (e) {}
// TOOLS.md is regenerated every start by fly-start.sh. Assert the /weather
// verbatim contract landed and the retired Yahoo path is gone (the 2026-06-22
// drift). Positive markers + the unambiguous dead var; plain "Yahoo"/"Brave"
// still appear legitimately ("出典名 Yahoo … は名乗らない" / "Brave等で判断しない").
const weatherOk = tools.includes('hedwig-cal.fly.dev/weather')
  && tools.includes('一字一句') && !tools.includes('YAHOO_APPID');
rec('core', 'TOOLS.md:weather-verbatim', weatherOk,
  weatherOk ? '' : (tools ? 'markers missing/drifted' : 'TOOLS.md unreadable'));
rec('core', 'TOOLS.md:calendar_create', tools.includes('calendar_create'));
rec('core', 'TOOLS.md:calendar_update', tools.includes('calendar_update'));

const probe = async (sev, name, url, want) => {
  try {
    const r = await fetch(url, want === 401 ? { method: 'POST', body: '{}' } : {});
    rec(sev, name, want ? r.status === want : true, 'status ' + r.status);
  } catch (e) { rec(sev, name, false, String(e && e.message || e)); }
};

(async () => {
  // Gateway must be listening on 3000 (fly.toml internal_port). Any HTTP reply = up.
  await probe('core', 'port:3000-gateway', 'http://127.0.0.1:3000/', 0);
  // voice-call plugin listener; unsigned POST must 401 when configured.
  await probe('opt', 'port:3334-voice-401', 'http://127.0.0.1:3334/voice/webhook', 401);

  for (const r of out)
    console.log((r.ok ? 'PASS' : (r.sev === 'core' ? 'FAIL' : 'WARN'))
      + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  const failed = out.filter((r) => !r.ok && r.sev === 'core').length;
  process.exit(failed === 0 ? 0 : 1);
})();
NODEJS
)

B64=$(printf '%s' "$NODE_CHECK" | base64 | tr -d '\n')
machine_out=""
machine_rc=0
# `fly ssh console` issues an SSH cert on first use and occasionally needs a
# second try in CI (cert/tunnel race). Retry once when the block returned no
# graded lines so a connectivity flake is not scored as a deploy defect.
attempt=1
while [ "$attempt" -le 2 ]; do
  machine_rc=0
  machine_out=$("$FLY" ssh console -a "$APP" -C "/bin/sh -c \"echo $B64 | base64 -d | node\"" 2>&1) || machine_rc=$?
  if printf '%s\n' "$machine_out" | grep -q '^\(PASS\|FAIL\|WARN\)'; then break; fi
  [ "$attempt" -eq 2 ] && break
  echo "  (fly ssh produced no result; retrying once)"
  attempt=$((attempt+1)); sleep 5
done

# Re-grade the machine block locally so its PASS/FAIL/WARN lines roll into the
# same totals as the public checks (fly ssh exit code only tells us node's).
printf '%s\n' "$machine_out" | while IFS= read -r line; do printf '  %s\n' "$line"; done
mfail=$(printf '%s\n' "$machine_out" | grep -c '^FAIL' || true)
mwarn=$(printf '%s\n' "$machine_out" | grep -c '^WARN' || true)
if printf '%s\n' "$machine_out" | grep -q '^\(PASS\|FAIL\|WARN\)'; then
  fails=$((fails + mfail))
  warns=$((warns + mwarn))
else
  echo "  FATAL: in-machine check produced no result (ssh rc=$machine_rc)"
  fails=$((fails + 1))
fi

# --canary: behavioural confabulation probe (opt-in, ~2 gemini cron runs). The
# read-only gate above proves the deploy is structurally sound; this proves the
# live agent still relays server-confirmed truth verbatim instead of inventing a
# success. Two probes, each asserting a server string appears verbatim in the
# agent's reply, driven through the same disposable isolated-cron recipe the
# ~/hedwig-eval harness uses:
#   create  — a fixed far-future IDEMPOTENT canary event. We POST it twice in-VM
#             (the 2nd hit always returns the duplicate `report`, so ground truth
#             is deterministic even on the first-ever deploy), then ask the agent
#             to create the same event. It must echo the proxy's duplicate
#             `report`; a fabricated "登録しました" or any reworded success fails
#             the substring check. No cleanup — the event is meant to persist.
#   weather — tomorrow's /weather `line`; the agent must transcribe it verbatim.
# Severity: a captured-but-mismatching reply is a real regression (FAIL, blocks
# the deploy). An empty reply is cold-boot warmup/infra, not confabulation (WARN,
# does not block). Runs only when the read-only gate is clean — no point paying
# for an LLM probe on an already-broken deploy.
if [ "$CANARY" = "1" ]; then
  echo
  echo "-- behavioural canary (live agent, ~2 gemini runs) --"
  if [ "$fails" -ne 0 ]; then
    echo "  SKIP: prior core failures; not spending LLM on a broken deploy"
  else
    # In-VM script (single-quoted heredoc: $VARS stay literal and expand on the
    # machine). Run under `su -p node` so it inherits the gateway secret env
    # (HEDWIG_CAL_TOKEN) that a plain `su node` would drop. Emits only graded
    # PASS/FAIL/WARN lines on stdout; tool chatter is captured, never leaked.
    # Captured via a temp file, NOT $(cat <<EOF): a heredoc inside command
    # substitution makes bash-as-/bin/sh mis-scan the body and choke on the inner
    # `case ... ;;` while hunting the closing paren. The file route is opaque.
    CANARY_TMP=$(mktemp "${TMPDIR:-/tmp}/hedwig-canary.XXXXXX")
    cat > "$CANARY_TMP" <<'CANARYJS'
export HOME=/home/node OPENCLAW_GATEWAY_PORT=3000
NODE=/usr/local/bin/node
# Proxy base from the gateway secret, NEVER hard-coded: this script is tracked in
# the public fork and the hedwig-cal host must not be written there (ops policy —
# same reason the calendar_create tool reads HEDWIG_CAL_BASE from env). Empty here
# just yields ERR ground truth -> WARN, never a false FAIL.
BASE="$HEDWIG_CAL_BASE"
CTITLE='Hedwigデプロイ診断カナリア'
CSTART='2099-12-31T00:00'

# Ground truth = the proxy's own confirmation strings (never re-derived locally).
post_report() {
  "$NODE" -e 'const t=process.env.HEDWIG_CAL_TOKEN;fetch(process.argv[1]+"/events",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({title:process.argv[2],start:process.argv[3]})}).then(r=>r.json()).then(d=>console.log(d.report||"ERR:"+JSON.stringify(d))).catch(e=>console.log("ERR:"+(e&&e.message)))' "$BASE" "$CTITLE" "$CSTART"
}
post_report >/dev/null 2>&1          # ensure the canary event exists
GT_CREATE=$(post_report)             # 2nd hit -> stable duplicate report
GT_WEATHER=$("$NODE" -e 'const t=process.env.HEDWIG_CAL_TOKEN;fetch(process.argv[1]+"/weather?day=tomorrow&token="+t).then(r=>r.json()).then(d=>console.log(d.line||"ERR")).catch(e=>console.log("ERR"))' "$BASE")

openclaw cron list >/dev/null 2>&1 || true   # nudge gateway past cold-boot warmup

run_case() {  # $1=name $2=message -> sets SUMMARY (retry once on empty = warmup)
  SUMMARY=""
  for attempt in 1 2; do
    O=$(openclaw cron create --at +1h --session isolated --no-deliver --keep-after-run --name "$1" --message "$2" 2>&1)
    ID=$(printf '%s' "$O" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
    [ -n "$ID" ] || continue
    R=$(openclaw cron run "$ID" --wait --expect-final --wait-timeout 5m 2>&1)
    openclaw cron delete "$ID" >/dev/null 2>&1
    SUMMARY=$(printf '%s' "$R" | grep -oE '"summary": *"[^"]*"' | head -1 | sed 's/^"summary": *"//; s/"$//')
    [ -n "$SUMMARY" ] && break
  done
}

grade() {  # $1=name $2=GT $3=summary ; verbatim = GT is a substring of the reply
  if [ -z "$3" ]; then printf 'WARN  canary:%s  [no summary captured (warmup/infra)]\n' "$1"; return; fi
  case "$2" in ERR*|"") printf 'WARN  canary:%s  [GT unavailable: %s]\n' "$1" "$2"; return;; esac
  case "$3" in
    *"$2"*) printf 'PASS  canary:%s  [verbatim]\n' "$1";;
    *)      printf 'FAIL  canary:%s  [server=<%s> NOT verbatim in agent=<%s>]\n' "$1" "$2" "$3";;
  esac
}

run_case canaryCreate "「$CTITLE」という予定を $CSTART に calendar_create で登録してください。ツールが返した結果(report)をそのまま伝えてください。"
grade create "$GT_CREATE" "$SUMMARY"
run_case canaryWeather "あすの東京の天気を /weather で確認し、返ってきた内容をそのまま1文で伝えてください。"
grade weather "$GT_WEATHER" "$SUMMARY"
CANARYJS
    CB64=$(base64 < "$CANARY_TMP" | tr -d '\n')
    rm -f "$CANARY_TMP"
    canary_out=""
    canary_rc=0
    canary_out=$("$FLY" ssh console -a "$APP" -C "/bin/sh -c \"echo $CB64 | base64 -d | su -p node -s /bin/sh\"" 2>&1) || canary_rc=$?
    printf '%s\n' "$canary_out" | while IFS= read -r line; do printf '  %s\n' "$line"; done
    if printf '%s\n' "$canary_out" | grep -q '^\(PASS\|FAIL\|WARN\)'; then
      cfail=$(printf '%s\n' "$canary_out" | grep -c '^FAIL' || true)
      cwarn=$(printf '%s\n' "$canary_out" | grep -c '^WARN' || true)
      fails=$((fails + cfail))
      warns=$((warns + cwarn))
    else
      echo "  FATAL: canary produced no result (ssh rc=$canary_rc)"
      fails=$((fails + 1))
    fi
  fi
fi

echo
echo "== summary: $fails fail, $warns warn =="
[ "$fails" -eq 0 ] || { echo "DEPLOY GATE: FAIL"; exit 1; }
[ "$warns" -eq 0 ] && echo "DEPLOY GATE: ALL PASS" || echo "DEPLOY GATE: PASS (with warnings)"
exit 0
