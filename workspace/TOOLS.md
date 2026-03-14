---
summary: "Olaf's local tools and operator commands"
read_when:
  - User asks about kill commands, agent management, or system control
  - Bootstrapping a workspace manually
---

# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

---

## 🔴 Mariner Agent Kill Commands

These are your two operator kill commands. Run them **inside the container** when the user tells you to.

### How to run inside the container

```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-all-agents.sh
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-stale-agents.sh
```

---

### Command 1: KILL EVERYTHING (`kill all agents`)

**Trigger phrases:** "kill everything", "kill all agents", "nuke the agents", "kill all", "stop all agents", "shut it all down"

**What it does:**
- Kills ALL watchdogs, humanizer daemons, assistant daemons, openclaw agent workers, session-daemons
- Marks ALL incomplete sessions as terminated in their JSONL
- Cleans up PID files
- **Preserves:** openclaw server, gateway, director, director-watchdog, task-api.js, MLX/Chromium browser

**Command:**
```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-all-agents.sh
```

**Dry run (check what would be killed first):**
```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-all-agents.sh --dry-run
```

---

### Command 2: KILL STALE AGENTS (`kill stale agents`)

**Trigger phrases:** "kill stale agents", "clean up stale sessions", "kill idle agents", "kill zombies", "clean up agents", "kill stuck agents"

**What it does:**
- Finds sessions where JSONL file hasn't been written to in >15 minutes AND session isn't marked complete
- Kills only the processes for those stale sessions (watchdogs → humanizer → assistant → pilot → session-daemon)
- Leaves active sessions alone
- Marks stale sessions as terminated

**Command (default 15-minute threshold):**
```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-stale-agents.sh
```

**Custom threshold (e.g., 30 minutes):**
```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-stale-agents.sh --threshold-minutes 30
```

**Dry run:**
```bash
docker exec openclaw-mrdz-openclaw-1 bash /data/mariner/kill-stale-agents.sh --dry-run
```

---

### Response format

After running either command, report back the JSON output to the user. Key fields:
- `killed_sessions` — list of session IDs that were terminated
- `killed_pid_count` — how many processes were killed
- `message` — human-readable summary

Example response to user: *"Done. Killed 3 stale sessions and 12 processes. Core infrastructure untouched."*

---

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.