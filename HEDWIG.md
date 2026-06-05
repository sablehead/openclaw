# Hedwig — Personal AI Assistant Setup

This document explains the context for Antigravity and other agents reviewing this repository.

## This Repository

**openclaw/openclaw** is an upstream open-source project. The code in `src/`, `extensions/`, `packages/`, `.github/` etc. is NOT written by sable — it is third-party OSS.

Do not treat changes to upstream files as sable's original authorship.

## What sable is actually doing

Building a personal AI assistant called **Hedwig**, running on Fly.io (Tokyo, NRT).

Hedwig is an OpenClaw gateway instance — essentially a hosted personal AI with long-term memory, tool access, and eventually a team of specialist agents managed by Hedwig as chief of staff.

## Key files that ARE sable's work

| File                       | Purpose                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `fly.toml`                 | Fly.io app config (app=sableshedwig, region=nrt, performance-1x:2GB)                             |
| `scripts/fly-root-init.sh` | Root wrapper — `chown -R node:node /data` then `exec su node` to `fly-start.sh`                 |
| `scripts/fly-start.sh`     | Startup script — merges openclaw.json config, writes workspace files, launches gateway            |
| `Dockerfile`               | Container image — `OPENCLAW_INSTALL_SKILL_DEPS` section, `USER node` commented out for root init |
| `HEDWIG.md`                | This file                                                                                        |

## Companion services

| App          | URL                          | Purpose                                                                                                                                     |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `hedwig-cal` | `https://hedwig-cal.fly.dev` | Google Calendar proxy — exposes `GET /events?date=YYYY-MM-DD`; handles OAuth2 internally so Hedwig can access Calendar via `web_fetch`       |

## Agent roles

| Agent           | Role                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Claude Code** | Primary implementer — makes changes, writes code, manages config                                 |
| **Antigravity** | Third-party auditor — reviews Claude Code's work for correctness, security, and intent alignment |

Antigravity should evaluate: "Does this change serve sable's goal? Is it safe? Is there a better approach?"

## Current state (as of 2026-06-05)

### Deployed and working (v2026.6.2 on `sableshedwig.fly.dev`)

- **Gateway**: OpenClaw gateway on Fly.io NRT, `performance-1x:2GB`
- **Workspace**: persisted to `/data/workspace` (survives redeploys)
- **Long-term memory**: `MEMORY.md` + `memory/YYYY-MM-DD.md`, auto-injected via `active-memory` plugin
- **Enabled tools**: `web_fetch`, `write`, `web_search`
- **Enabled skills**: `coding-agent` (Claude Code)
- **Search**: Brave Search (via plugin)
- **APIs available to Hedwig** (via `TOOLS.md`):
  - Yahoo Weather API (降水予報)
  - Google Calendar via `hedwig-cal.fly.dev` proxy
  - Google Places API (場所検索)

### Installed CLIs (via `OPENCLAW_INSTALL_SKILL_DEPS`)

| CLI             | Purpose                                |
| --------------- | -------------------------------------- |
| `gh`            | GitHub CLI                             |
| `gemini-cli`    | Google Gemini CLI                      |
| `claude`        | Claude Code (`@anthropic-ai/claude-code`) |
| `clawhub`       | ClawHub CLI                            |
| `blogwatcher`   | Blog monitoring                        |
| `gifgrep`       | GIF search                             |
| `sag`           | ElevenLabs TTS CLI                     |
| `himalaya`      | Email CLI (⚠ OAuth2 未対応、後述)       |
| `nano-pdf`      | PDF utility (Python)                   |

### Startup flow

1. `fly-root-init.sh` runs as root → `chown -R node:node /data` → `exec su node` handoff
2. `fly-start.sh` runs as node → merges gateway config into `openclaw.json` → writes Brave/Google API/Calendar/himalaya credentials → bootstraps workspace files (IDENTITY/USER/SOUL/MEMORY/TOOLS.md) → launches `node openclaw.mjs gateway`

### Fly Secrets (configured)

`GOOGLE_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `YAHOO_APP_ID`, `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ICAL_URL`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_GMAIL_REFRESH_TOKEN`, `NOTION_API_KEY`, `GITHUB_TOKEN`, `ELEVENLABS_API_KEY`

### Resolved issues

- **Root ownership problem**: `openclaw doctor --fix` resets `/data/openclaw.json` to root ownership → solved by `fly-root-init.sh` doing `chown` before dropping to node. `Dockerfile` `USER node` is commented out to allow this.

## Deploy procedure

```bash
cd /Users/sable/openclaw
~/bin/flyctl-old deploy --app sableshedwig --depot=false --remote-only
```

- **`~/bin/flyctl-old` (v0.3.112) required**: latest flyctl v0.4.57+ has unix socket parse bug
- **`--depot=false` required**: Depot OOMs on tsdown build
- Build takes ~10 minutes
- Remote builder recovery: `fly machine restart fly-builder-tender-sky-7394 --app fly-builder-tender-sky-7394`
- Doctor on server: `su node -s /bin/sh -c "node openclaw.mjs doctor --fix"` (never run as root)

## Open issues

### himalaya OAuth2 binary problem

The official himalaya release binary is built without the `oauth2` cargo feature. The config in `fly-start.sh` writes `type = "oauth2"` but the binary errors with `missing 'oauth2' cargo feature`.

OAuth2 tokens are ready (`GOOGLE_GMAIL_REFRESH_TOKEN` set, Google OAuth consent screen published, `https://mail.google.com/` scope added to Calendar OAuth client).

Options:
1. Build an OAuth2-enabled himalaya binary from source
2. Skip himalaya; build a Gmail proxy like `hedwig-cal.fly.dev`
3. Use `web_fetch` to call Gmail API directly (add to TOOLS.md)

## TODO

- [ ] Resolve himalaya email (see above)
- [ ] voice-call plugin setup
- [ ] obsidian-cli + Google Drive Vault mount

## Hedwig's intended future

Hedwig will coordinate a team of specialist agents (weather, research, etc.) as chief of staff, acting as sable's direct personal assistant. The current setup is the foundation for that architecture.
