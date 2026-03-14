---
name: browser
description: "Humanized Playwright Browser CLI — the browser execution system for all worker agents. Provides accessibility tree snapshots, ref-based element interaction, multi-tab management, and JSONL session logging with watchdog recovery."
triggers:
  - browser
  - navigate
  - click
  - type
  - snapshot
  - session
  - browser-cli
---

# Browser Skill — Humanized Playwright CLI

## Architecture Overview

```
exec.js (CLI) → session-daemon.js (Unix socket) → humanizer.js → CDP → Mimic Browser
                       ↓
              /data/sessions/<id>.jsonl  ←  watchdog monitors (30s interval, 45s freeze)
```

## Session Lifecycle

```bash
# 1. Start (once per mission)
node /data/browser-cli/start-session.js \
  --session <id> --account <accountId> --platform <platform>

# 2. Execute commands
node /data/browser-cli/exec.js snapshot --session <id>
node /data/browser-cli/exec.js act --session <id> --ref eN --kind click
node /data/browser-cli/exec.js navigate --session <id> --url <url>

# 3. Checkpoint after each task (REQUIRED for watchdog health)
node /data/browser-cli/exec.js checkpoint --session <id> --task <name> --status done

# 4. Stop (when mission complete)
node /data/browser-cli/stop-session.js --session <id>
```

## All Commands

| Command | Purpose |
|---------|---------|
| `snapshot` | Get accessibility tree with e1..eN refs |
| `act --ref eN --kind click\|fill\|type\|check\|press` | Interact with element |
| `navigate --url <url>` | Navigate (with human detour behavior) |
| `open-tab --url <url>` | Open background tab |
| `switch-tab --tab <tabId>` | Switch active tab |
| `background-breathe --tab <tabId>` | Humanized background tab visit |
| `close-tab --tab <tabId>` | Close a tab |
| `scroll --pixels N --direction up\|down` | Human scroll |
| `wait --ms N` | Wait N milliseconds |
| `screenshot --path <p>` | Save screenshot |
| `get-text` | Get page innerText |
| `press-key --key <Enter\|Tab\|Escape>` | Press keyboard key |
| `checkpoint --task N --status done\|failed` | Write JSONL checkpoint |
| `status` | Show session health + tabs |
| `stop` | Graceful daemon shutdown |

## Human Behavior (automatic)

All behavior is handled by humanizer.js — agents don't configure this:

| Behavior | Implementation |
|----------|---------------|
| Mouse movement | Bézier curves, Gaussian speed 40–85px/s |
| Click hesitation | 200–500ms hover before every click |
| Click accuracy | 5–15px random offset from element center |
| Typing speed | Gaussian key delays, fast digraph pairs |
| Typing errors | 4–9% rate → adjacent key → 600–1500ms realization → backspace → retype |
| Scroll momentum | Decelerating bursts, 600–3500ms dwell |
| Navigation | 25% exploratory detour before target |
| Tab switching | 1–5s idle before switching, 300–800ms orient after |

## JSONL Log Format

Every event written to `/data/sessions/<sessionId>.jsonl`:

```jsonl
{"ts":...,"type":"session_start","accountId":"...","platform":"linkedin","tasks":[...]}
{"ts":...,"type":"navigate","tabId":"tab-0","url":"https://linkedin.com/feed/"}
{"ts":...,"type":"snapshot","tabId":"tab-0","url":"...","refCount":38}
{"ts":...,"type":"action","action":"act","ref":"e6","kind":"click","label":"Like","x":452,"y":234,"result":"ok"}
{"ts":...,"type":"checkpoint","completedTasks":["like_post"],"pendingTasks":["send_connection_request"],"tabState":[...],"daemonPid":12345}
```

## Watchdog Integration

The watchdog (`/data/executor/watchdog.js`) runs every 30s and checks JSONL mtime:
- `< 45s ago` → HEARTBEAT_OK
- `> 45s ago` → FROZEN → kill agent → read last checkpoint → restart with resume message
- Browser daemon stays alive across restarts — tabs preserved
- Agent resumes from exact last checkpoint — no repeated work
