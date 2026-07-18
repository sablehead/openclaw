#!/usr/bin/env python3
"""
Hedwig mail alert poller — called by hedwig-mail-alert.yml.

Fetches important new mail from hedwig-cal GET /alerts (deduped server-side via a
monotonic cursor) and sends a direct Telegram DM when something new arrives. No
LLM is involved: the server pre-composes each `line`, so this forwards it
verbatim — the same confabulation-proof echo-back discipline as the briefs.

Exit 0 on a normal poll (including "nothing new"). A network/HTTP failure exits
non-zero so a persistently broken poller shows as a red run; a single transient
failure just skips that poll (the server cursor only advances when /alerts is
actually served, so nothing is lost).
"""
import json
import os
import sys
import urllib.request

base = (os.environ.get("HEDWIG_CAL_BASE") or "").rstrip("/")
cal_token = os.environ.get("HEDWIG_CAL_TOKEN", "")
tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# Owner id comes from the secret only. This fork is public, so it must not carry
# a personal Telegram id as a literal — same rule that keeps HEDWIG_CAL_BASE out.
chat_id = os.environ.get("HEDWIG_OWNER_CHAT_ID", "")

# Every secret is required up front: serving /alerts advances the server-side
# cursor, so polling without a way to deliver would drop those alerts for good.
if not base or not cal_token or not chat_id or not tg_token:
    print(
        "missing HEDWIG_CAL_BASE / HEDWIG_CAL_TOKEN / HEDWIG_OWNER_CHAT_ID"
        " / TELEGRAM_BOT_TOKEN",
        file=sys.stderr,
    )
    sys.exit(1)


def fetch_alerts():
    # Bearer header (not ?token=) so the proxy token never lands in any URL log.
    req = urllib.request.Request(
        f"{base}/alerts", headers={"Authorization": f"Bearer {cal_token}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def send_telegram(text):
    body = json.dumps(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    ).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{tg_token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def main():
    data = fetch_alerts()
    if data.get("bootstrapped"):
        print("cursor bootstrapped (no backlog replay)")
        return
    alerts = data.get("alerts", [])
    if not alerts:
        print("no new important mail")
        return
    # One DM per poll listing every new line, so a burst is a single notification.
    # Lines are server-confirmed; we add only a fixed header — no model, no summary.
    header = "📬 重要メール" if len(alerts) == 1 else f"📬 重要メール {len(alerts)}件"
    send_telegram(header + "\n" + "\n".join(a["line"] for a in alerts))
    print(f"sent {len(alerts)} alert(s)")


try:
    main()
except Exception as e:
    print(f"mail-alert failed: {e}", file=sys.stderr)
    sys.exit(1)
