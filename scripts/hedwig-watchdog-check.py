#!/usr/bin/env python3
"""
Hedwig brief watchdog check — called by hedwig-brief-watchdog.yml.

Reads cron list JSON from $CRON_LIST_FILE (written by flyctl ssh console),
decides which brief this run is responsible for, and sends a Telegram DM if the
brief did not run/deliver, or if SSH failed.

Exit 0 on any check outcome (alert is sent via Telegram, not via exit code).
Exits 1 only when the alert path itself is unconfigured (missing secrets), so CI
fails loudly instead of running green while unable to alert.
"""
import datetime
import json
import os
import re
import sys
import urllib.request

# (label, cron id, expected UTC fire minute-of-day). The briefs fire at
# 07:00/21:00 JST == 22:00/12:00 UTC; the watchdog is scheduled 30 min later.
MORNING_ID = "b0f26c87-d537-44cb-943f-ca3575c14d89"
EVENING_ID = "5ae4aecb-2ebd-44ad-b766-8f37324f1245"
BRIEFS = [
    ("朝ブリーフ", MORNING_ID, 22 * 60),
    ("夕ブリーフ", EVENING_ID, 12 * 60),
]

# Freshness is anchored to the brief's own expected fire time, never to a window
# measured back from "now". GitHub's scheduled runners fire 60-260 min late under
# load, so a rolling window made a healthy brief look stale: 23/24 evening runs
# alerted falsely (measured 2026-06-26..07-18). A dead-man's switch that cries
# wolf nightly trains the owner to ignore the one real outage, so the anchor must
# be delay-immune.
SKEW_MS = 5 * 60 * 1000  # clock skew between the VM's cron clock and the runner
# Below this the brief may still be mid-flight, so silence beats a false alarm.
SETTLE_MS = 20 * 60 * 1000

tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# Owner id comes from the secret only. This fork is public, so it must not carry
# a personal Telegram id as a literal — same rule that keeps HEDWIG_CAL_BASE out.
chat_id = os.environ.get("HEDWIG_OWNER_CHAT_ID", "")
run_url = os.environ.get("RUN_URL", "")

# A dead-man's switch that cannot reach anyone must fail loudly in CI rather than
# run green while silently unable to alert.
if not tg_token or not chat_id:
    print("missing TELEGRAM_BOT_TOKEN / HEDWIG_OWNER_CHAT_ID", file=sys.stderr)
    sys.exit(1)


def send_alert(text):
    body = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{tg_token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        print("Alert sent via Telegram")
    except Exception as e:
        print(f"TG send failed: {e}", file=sys.stderr)


def last_expected_ms(now, utc_minute):
    """Most recent UTC occurrence of `utc_minute`, at or before `now`."""
    fire = now.replace(
        hour=utc_minute // 60, minute=utc_minute % 60, second=0, microsecond=0
    )
    if fire > now:
        fire -= datetime.timedelta(days=1)
    return int(fire.timestamp() * 1000)


def main():
    if os.environ.get("SSH_OK") == "0":
        send_alert(
            "🦉🚨 Hedwig dead-man's switch: flyctl SSH 接続失敗。VM が応答していません。"
            f"\n\n{run_url}"
        )
        return

    raw = open(os.environ["CRON_LIST_FILE"]).read()
    now = datetime.datetime.now(datetime.timezone.utc)
    now_ms = int(now.timestamp() * 1000)

    scheduled = [(label, jid, last_expected_ms(now, m)) for label, jid, m in BRIEFS]
    if os.environ.get("CHECK_BOTH", "false").lower() == "true":
        to_check = scheduled
    else:
        # Whichever brief fired most recently is the one this run covers. Picking
        # by elapsed time rather than by wall-clock bucket keeps a badly delayed
        # run attributed to the right brief instead of falling through to "both".
        to_check = [max(scheduled, key=lambda b: b[2])]

    m = re.search(r"\{[\s\S]*\}", raw)
    jobs = []
    if m:
        try:
            jobs = json.loads(m.group()).get("jobs", [])
        except Exception:
            pass

    problems = []
    for label, jid, expected_ms in to_check:
        if now_ms - expected_ms < SETTLE_MS:
            print(f"{label}: 判定保留（発火から{(now_ms - expected_ms) // 60000}分）")
            continue
        job = next((j for j in jobs if j["id"] == jid), None)
        if not job:
            problems.append(f"• {label}: cronジョブ不明 (ID: {jid})")
            continue
        state = job.get("state", {})
        last_run = state.get("lastRunAtMs") or 0
        delivered = state.get("lastDelivered") is True
        expected_jst = datetime.datetime.fromtimestamp(
            expected_ms / 1000, datetime.timezone(datetime.timedelta(hours=9))
        ).strftime("%m/%d %H:%M")
        if last_run < expected_ms - SKEW_MS:
            age = f"{(now_ms - last_run) // 60000}分前" if last_run else "記録なし"
            problems.append(f"• {label}: {expected_jst} JST の回が未実行（最終 {age}）")
        elif not delivered:
            problems.append(f"• {label}: {expected_jst} JST の回は実行済みだが未配信")
        else:
            print(f"{label}: OK（{expected_jst} JST の回を配信済み）")

    if problems:
        msg = (
            "🦉🚨 Hedwig dead-man's switch: ブリーフ未配信を検知\n\n"
            + "\n".join(problems)
            + f"\n\n詳細: {run_url}"
        )
        print(f"Problems: {problems}")
        send_alert(msg)
    else:
        print("All checked briefs delivered OK")


if __name__ == "__main__":
    main()
