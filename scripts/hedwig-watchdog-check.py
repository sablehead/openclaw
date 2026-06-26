#!/usr/bin/env python3
"""
Hedwig brief watchdog check — called by hedwig-brief-watchdog.yml.

Reads cron list JSON from $CRON_LIST_FILE (written by flyctl ssh console),
decides which brief(s) to verify based on JST hour (or CHECK_BOTH=true),
and sends a Telegram DM if delivery is missing or SSH failed.

Exit 0 always (alert is sent via Telegram, not via exit code).
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.request

MORNING_ID = "b0f26c87-d537-44cb-943f-ca3575c14d89"
EVENING_ID = "5ae4aecb-2ebd-44ad-b766-8f37324f1245"
BRIEFS = [("朝ブリーフ", MORNING_ID), ("夕ブリーフ", EVENING_ID)]
WINDOW_MS = 90 * 60 * 1000

tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
chat_id = os.environ.get("HEDWIG_OWNER_CHAT_ID") or "8709180805"
run_url = os.environ.get("RUN_URL", "")


def send_alert(text):
    if not tg_token:
        print(f"[no-tg-secret] ALERT: {text[:120]}", file=sys.stderr)
        return
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


def main():
    if os.environ.get("SSH_OK") == "0":
        send_alert(
            "🦉🚨 Hedwig dead-man's switch: flyctl SSH 接続失敗。VM が応答していません。"
            f"\n\n{run_url}"
        )
        return

    raw = open(os.environ["CRON_LIST_FILE"]).read()
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - WINDOW_MS

    hour_jst = (datetime.datetime.utcnow().hour + 9) % 24
    check_both = os.environ.get("CHECK_BOTH", "false").lower() == "true"
    if check_both:
        to_check = BRIEFS
    elif 7 <= hour_jst < 10:
        to_check = [("朝ブリーフ", MORNING_ID)]
    elif 21 <= hour_jst or hour_jst < 1:
        to_check = [("夕ブリーフ", EVENING_ID)]
    else:
        to_check = BRIEFS  # dispatch outside expected windows: check both

    m = re.search(r"\{[\s\S]*\}", raw)
    jobs = []
    if m:
        try:
            jobs = json.loads(m.group()).get("jobs", [])
        except Exception:
            pass

    problems = []
    for label, jid in to_check:
        job = next((j for j in jobs if j["id"] == jid), None)
        if not job:
            problems.append(f"• {label}: cronジョブ不明 (ID: {jid})")
            continue
        state = job.get("state", {})
        last_run = state.get("lastRunAtMs") or 0
        delivered = state.get("lastDelivered") is True
        if last_run < cutoff_ms:
            age = (now_ms - last_run) // 60000 if last_run else "不明"
            problems.append(f"• {label}: 90分以内に実行なし（最終 {age}分前）")
        elif not delivered:
            problems.append(f"• {label}: 実行済みだが未配信")
        else:
            age = (now_ms - last_run) // 60000
            print(f"{label}: OK（{age}分前に配信済み）")

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


main()
