# Hedwig — Personal AI Assistant Setup

This document explains the context for Antigravity and other agents reviewing this repository.

## This Repository

**openclaw/openclaw** is an upstream open-source project. The code in `src/`, `extensions/`, `packages/`, `.github/` etc. is NOT written by sable — it is third-party OSS.

Do not treat changes to upstream files as sable's original authorship.

## What sable is actually doing

Building a personal AI assistant called **Hedwig**, running on Fly.io (Tokyo, NRT).

Hedwig is an OpenClaw gateway instance — essentially a hosted personal AI with long-term memory, tool access, and eventually a team of specialist agents managed by Hedwig as chief of staff.

## Key files that ARE sable's work

| File                   | Purpose                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `scripts/fly-start.sh` | Startup script for Fly.io — writes openclaw.json config and workspace files at every deploy |
| `fly.toml`             | Fly.io app config                                                                           |
| `Dockerfile`           | Container image for Hedwig                                                                  |

## Companion services

| App          | URL                          | Purpose                                                                                                                                     |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `hedwig-cal` | `https://hedwig-cal.fly.dev` | Google Calendar proxy — exposes `GET /events?date=YYYY-MM-DD`; handles OAuth2 POST internally so Hedwig can access Calendar via `web_fetch` |

These are the files that actually matter for the Hedwig deployment. Everything else is upstream.

## Agent roles

| Agent           | Role                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Claude Code** | Primary implementer — makes changes, writes code, manages config                                 |
| **Antigravity** | Third-party auditor — reviews Claude Code's work for correctness, security, and intent alignment |

Antigravity should evaluate: "Does this change serve sable's goal? Is it safe? Is there a better approach?"

## Current state of the repo (as of 2026-04-23)

### Deployed and working on Fly.io

- Workspace persisted to `/data/workspace` (survives redeploys)
- Long-term memory via `MEMORY.md` and `memory/YYYY-MM-DD.md`
- `active-memory` plugin: auto-injects past memories before each reply
- `write` and `web_fetch` tools enabled for Hedwig

### Local branch `security/ci-hardening-and-skill-improvements`

Changes to upstream files (CI workflows, agent skills, extensions) made during a security audit pass. **These cannot be pushed upstream** (sable is not a maintainer). They have no effect on Hedwig. They can be discarded or kept as local reference.

## Hedwig's intended future

Hedwig will coordinate a team of specialist agents (weather, research, etc.) as chief of staff, acting as sable's direct personal assistant. The current setup is the foundation for that architecture.
