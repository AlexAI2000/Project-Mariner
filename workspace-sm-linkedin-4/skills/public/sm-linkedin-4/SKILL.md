---
name: sm-linkedin-4
description: "Execute LinkedIn working sessions and account creation. Autonomous browser operator using Humanized Playwright CLI with accessibility tree navigation."
triggers:
  - linkedin
  - like post
  - connection request
  - send message
  - follow company
  - post comment
  - working session
  - account creation
---

# LinkedIn Browser Operator Skill

## Architecture

```
Your bash commands
      ↓
/data/browser-cli/exec.js  (CLI)
      ↓ Unix socket
session-daemon.js  (persistent browser process)
      ↓ humanizer.js
CDP Proxy → Mimic Browser (MLX)
      ↓
/data/sessions/$SESSION_ID.jsonl  (watchdog monitor)
```

---

## Quick Reference

### Start Mission

```bash
# 1. Start session
node /data/browser-cli/start-session.js --session $SESSION_ID --account $ACCOUNT_ID --platform linkedin

# 2. Open background tab
node /data/browser-cli/exec.js open-tab --session $SESSION_ID --url https://news.ycombinator.com

# 3. Navigate to LinkedIn
node /data/browser-cli/exec.js navigate --session $SESSION_ID --url https://www.linkedin.com/feed/

# 4. Snapshot to check login state
node /data/browser-cli/exec.js snapshot --session $SESSION_ID
```

### Core Pattern (for every action)

```bash
# 1. Snapshot → get refs
node /data/browser-cli/exec.js snapshot --session $SESSION_ID

# 2. Read refs → find target (e.g., ref=e6 button "Like")

# 3. Act by ref
node /data/browser-cli/exec.js act --session $SESSION_ID --ref e6 --kind click

# 4. After completing task → checkpoint
node /data/browser-cli/exec.js checkpoint --session $SESSION_ID --task like_post --status done --note "summary"
```

### Selector Strategy

**Priority 1 — Accessibility ref (primary):**
Use `snapshot` → read ref list → `act --ref eN --kind click/fill`

**Priority 2 — Page text search (fallback if ref acts on wrong element):**
```bash
node /data/browser-cli/exec.js get-text --session $SESSION_ID
# Read page text → re-snapshot to find correct ref
```

**Priority 3 — Screenshot (for debugging):**
```bash
node /data/browser-cli/exec.js screenshot --session $SESSION_ID --path /tmp/debug.png
```

---

## LinkedIn-Specific Patterns

### Feed URL
`https://www.linkedin.com/feed/`

### People Search (for connection requests)
`https://www.linkedin.com/search/results/people/?network=%5B%22S%22%2C%22O%22%5D&origin=FACETED_SEARCH`

### Company Search (for page follows)
`https://www.linkedin.com/search/results/companies/?keywords=technology`

### Messaging
`https://www.linkedin.com/messaging/`

### Profile (own)
`https://www.linkedin.com/in/me/`

### Typical ref patterns in LinkedIn snapshots:
- `button "Like"` — like a post
- `button "Comment"` — open comment box
- `button "Connect"` — send connection request
- `button "Follow"` — follow a company
- `button "Send"` — submit form/message
- `button "Add a note"` — add note to connection request
- `textbox "Write a comment…"` — comment input
- `textbox "Write a message…"` — message input
- `textbox "Email or Phone"` — login field
- `textbox "Password"` — password field
- `button "Sign in"` — login submit

---

## Checkpoint Protocol

```bash
# Task succeeded
node /data/browser-cli/exec.js checkpoint \
  --session $SESSION_ID \
  --task <task_type> \
  --status done \
  --note "<brief description of what was done>"

# Task failed after retries
node /data/browser-cli/exec.js checkpoint \
  --session $SESSION_ID \
  --task <task_type> \
  --status failed \
  --note "<reason>"
```

**Write a checkpoint after EVERY task completion (success or failure).**

---

## Account Creation Workflow

```bash
# 1. Check if account exists
node /data/executor/pa-lookup.js $ACCOUNT_ID linkedin

# 2. If credentials exist → account already created → skip to profile setup

# 3. If no credentials → create account
node /data/browser-cli/exec.js navigate --session $SESSION_ID --url https://www.linkedin.com/signup/
node /data/browser-cli/exec.js snapshot --session $SESSION_ID
# Fill all signup fields by ref: email, password, name, etc.

# 4. Save credentials after creation
node /data/accounts/save-credentials.js $ACCOUNT_ID linkedin '{"email":"...","password":"..."}'

# 5. Profile setup: headline, bio, work history (from briefing)
```
