# TOOLS.md — LinkedIn Browser Operator

## MANDATORY: HEADFUL BROWSER ONLY — NO HEADLESS

> **CRITICAL RULE: You MUST NEVER launch Chromium or any browser in headless mode.**
> The browser MUST always be visible on the VPS display so the operator can monitor it.
> Headless browsers look like bots and defeat the entire purpose of MultiLogin X.

### If start-session.js fails:

1. **DO NOT** fall back to `chromium --headless` or any headless flag. This is forbidden.
2. Check if the MLX profile exists: `node /data/executor/pa-lookup.js $ACCOUNT_ID linkedin`
3. If MLX launcher is down, **STOP and report** — never improvise with headless Chromium.
4. Output: `ERROR: Cannot start browser — MultiLogin X unavailable. Operator must restart MLX.`

---


## Browser CLI

The primary interface for all browser actions. Every command communicates with the
session daemon over a Unix socket. The daemon maintains a persistent CDP connection
to your Mimic browser (MultiLogin X) and handles all human behavior automatically.

### Session Management

```bash
# Start a new browser session (once per mission)
node /data/browser-cli/start-session.js \
  --session ws-mdm-b997ca70-abc123 \
  --account mdm-b997ca70 \
  --platform linkedin \
  --tasks "like_post,send_connection_request,post_comment"

# Check session status (tabs, completed tasks, daemon health)
node /data/browser-cli/exec.js status --session ws-mdm-b997ca70-abc123

# Stop session when mission complete
node /data/browser-cli/stop-session.js --session ws-mdm-b997ca70-abc123
```

### Snapshot (Accessibility Tree)

```bash
node /data/browser-cli/exec.js snapshot --session $SESSION_ID [--tab tab-0]
```

Returns a flat list of all interactive elements with refs:
```
=== SNAPSHOT ===
URL: https://www.linkedin.com/feed/
Title: LinkedIn
Elements (38):
ref=e1  button  "Like"
ref=e2  button  "Comment"
ref=e3  button  "Share"
ref=e4  link  "John Doe • 1st"
ref=e5  textbox  "Search"
ref=e6  button  "Connect"
...
=== END SNAPSHOT ===
```

**Always snapshot before acting after a navigation or page change.**

### Act by Ref

```bash
# Click an element
node /data/browser-cli/exec.js act \
  --session $SESSION_ID --ref e1 --kind click

# Fill a text field (clears existing content first)
node /data/browser-cli/exec.js act \
  --session $SESSION_ID --ref e5 --kind fill --text "search query"

# Type into focused element (no clear)
node /data/browser-cli/exec.js act \
  --session $SESSION_ID --ref e5 --kind type --text "more text"

# Press a key
node /data/browser-cli/exec.js act \
  --session $SESSION_ID --ref e5 --kind press --text "Enter"

# Check a checkbox
node /data/browser-cli/exec.js act \
  --session $SESSION_ID --ref e9 --kind check
```

### Navigation

```bash
node /data/browser-cli/exec.js navigate \
  --session $SESSION_ID \
  --url https://www.linkedin.com/feed/
```

### Tab Management (multi-tab concurrency)

```bash
# Open a background tab (returns tabId)
node /data/browser-cli/exec.js open-tab \
  --session $SESSION_ID \
  --url https://news.ycombinator.com
# → "Opened new tab: tab-1 → https://news.ycombinator.com"

# Switch to a specific tab
node /data/browser-cli/exec.js switch-tab --session $SESSION_ID --tab tab-0

# Brief humanized visit to background tab then return to primary
node /data/browser-cli/exec.js background-breathe --session $SESSION_ID --tab tab-1

# Close a tab
node /data/browser-cli/exec.js close-tab --session $SESSION_ID --tab tab-1
```

### Scroll

```bash
node /data/browser-cli/exec.js scroll \
  --session $SESSION_ID \
  --pixels 600 \
  --direction down    # or: up
```

### Utilities

```bash
# Wait (non-blocking from agent perspective, uses actual sleep)
node /data/browser-cli/exec.js wait --session $SESSION_ID --ms 3000

# Screenshot (saved to /tmp/ by default)
node /data/browser-cli/exec.js screenshot \
  --session $SESSION_ID \
  --path /tmp/debug.png

# Get full page text
node /data/browser-cli/exec.js get-text --session $SESSION_ID

# Press a keyboard key directly
node /data/browser-cli/exec.js press-key --session $SESSION_ID --key Enter
node /data/browser-cli/exec.js press-key --session $SESSION_ID --key Tab
node /data/browser-cli/exec.js press-key --session $SESSION_ID --key Escape
```

### Checkpoints (CRITICAL — call after every task)

```bash
node /data/browser-cli/exec.js checkpoint \
  --session $SESSION_ID \
  --task like_post \
  --status done \
  --note "Liked post by Sarah about AI trends"
```

This writes a checkpoint to the JSONL log. The watchdog reads JSONL writes to know
you're alive. **If you don't checkpoint regularly, the watchdog thinks you're frozen
and will restart you.**

---

## Client Profile Lookup

```bash
node /data/executor/pa-lookup.js <accountId> linkedin
```

Returns JSON with: `mlProfileId`, `folderId`, `credentials.email`, `credentials.password`, `clientName`

---

## Session JSONL Log

Your session is fully logged to:
```
/data/sessions/<sessionId>.jsonl
```

Every action, snapshot, scroll, and checkpoint is recorded here. The watchdog
uses this file to detect freezes and restore state on restart.

---

## System Health

```bash
# Check daemon is running for your session
ls /tmp/browser-cli-daemon-$SESSION_ID.pid && echo "daemon alive"

# Check daemon log
tail -20 /tmp/browser-cli-$SESSION_ID.log

# Check session JSONL (last 5 events)
tail -5 /data/sessions/$SESSION_ID.jsonl | while read line; do echo $line | node -e "const d=require('fs');process.stdin.resume();let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(b);console.log(o.type,o.action||o.url||o.task||'');}catch{}})"; done
```
