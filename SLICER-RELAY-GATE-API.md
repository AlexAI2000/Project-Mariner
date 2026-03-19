# Slicer-Relay Gate — API Documentation
### For Lovable / Supabase Backend Developers

---

## Overview

The Slicer-Relay Gate is a Node.js HTTP server running on the VPS at port `4567`.
It is the **only** interface your Lovable AI agent needs to control the browser.

**What it does automatically (you don't need to think about this):**
- Receives your raw Playwright CLI command
- Runs it through the humanization engine (persona-driven idle delays, anti-pattern enforcement, scroll variation)
- Executes it against the real Chromium browser (Mimic via MultiLogin X)
- The browser itself applies physics-level humanization: Bézier mouse curves, variable typing speed + errors, decelerating scroll bursts
- Appends a `snapshot` call automatically so every action returns a fresh accessibility tree
- Returns the snapshot as the response

**Your agent's job is simple:** send a command → read the snapshot → decide next command → repeat.

---

## Base URL

```
http://187.77.141.181:4567
```

## Authentication

All endpoints (except `/health`) require a Bearer token header:

```
Authorization: Bearer 3a9c5d4e7f8b1236e45a7c9f0b1d2e3f
```

---

## Endpoints

---

### `GET /health`
**No auth required.** Use to verify the Gate is alive.

**Response:**
```json
{
  "status": "ok",
  "service": "slicer-relay-gate",
  "uptime": 3600,
  "pid": 12345
}
```

---

### `POST /mariner/session/start`
**Start a browser session for an account.**

Opens the MultiLogin X browser profile for this account and starts the session daemon.
**This is async** — responds immediately with `202 Accepted` and fires a callback when the browser is ready (takes 10–60 seconds for MLX to launch).

**Request:**
```json
{
  "accountId": "john-doe",
  "platform": "linkedin",
  "clientName": "John Doe",
  "sessionId": "my-session-abc123",
  "callbackUrl": "https://your-project.supabase.co/functions/v1/mariner-callback",
  "executionId": "exec-uuid-here"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `accountId` | ✅ | Client account ID (matches `clients.json` record) |
| `platform` | ✅ | `linkedin`, `instagram`, `twitter`, `facebook`, `google`, `microsoft` |
| `clientName` | ❌ | Human-readable name (used for profile creation if new) |
| `sessionId` | ❌ | Your chosen session ID. Auto-generated as `ms-<uuid8>` if omitted |
| `callbackUrl` | ❌ | HTTPS URL to POST when browser is ready |
| `executionId` | ❌ | Your tracking ID, echoed back in callback |

**Immediate response (202):**
```json
{
  "accepted": true,
  "sessionId": "my-session-abc123",
  "executionId": "exec-uuid-here",
  "accountId": "john-doe",
  "platform": "linkedin",
  "message": "Browser session starting. Callback will fire when ready."
}
```

**Callback payload (fires when browser is ready):**
```json
{
  "event": "session_ready",
  "success": true,
  "executionId": "exec-uuid-here",
  "sessionId": "my-session-abc123",
  "accountId": "john-doe",
  "platform": "linkedin",
  "daemonPid": 45678,
  "cdpUrl": "ws://172.18.0.3:59499/devtools/browser/...",
  "mlProfileId": "43fb31a3-bc24-481e-8dbf-78edf1d3be5d",
  "socketPath": "/tmp/browser-cli-my-session-abc123.sock",
  "durationMs": 23400,
  "error": null
}
```

If `success: false`, check `error` field.

---

### `POST /mariner/execute`
**Execute a browser command in a live session.**

**This is your main tool.** Send a raw exec.js command. The Gate humanizes it, executes it, and returns the accessibility tree snapshot.

**Request:**
```json
{
  "sessionId": "my-session-abc123",
  "accountId": "john-doe",
  "platform": "linkedin",
  "raw_command": "node /data/browser-cli/exec.js act --ref e5 --kind click --session my-session-abc123",
  "executionId": "exec-uuid-here",
  "expectScreenshot": false,
  "callbackUrl": "https://your-project.supabase.co/functions/v1/mariner-callback"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `raw_command` | ✅ | The exec.js command to run (see command reference below) |
| `sessionId` | ✅ | Active session ID (must match the `--session` arg in raw_command) |
| `accountId` | ❌ | For logging only |
| `platform` | ❌ | For logging only |
| `executionId` | ❌ | Your tracking ID, echoed back |
| `expectScreenshot` | ❌ | Set `true` to include base64 screenshot in response |
| `callbackUrl` | ❌ | Also POST result to this URL asynchronously |
| `timeoutMs` | ❌ | Max wait time in ms (default + max: 120000) |

**Response:**
```json
{
  "success": true,
  "executionId": "exec-uuid-here",
  "sessionId": "my-session-abc123",
  "accountId": "john-doe",
  "platform": "linkedin",
  "stdout": "=== SNAPSHOT ===\nURL: https://www.linkedin.com/feed/\nTitle: LinkedIn\nElements (47):\nref=e1  button  \"Start a post\"\nref=e2  link  \"Home\"\n...\n=== END SNAPSHOT ===",
  "stderr": "",
  "screenshotBase64": null,
  "durationMs": 2840,
  "timedOut": false
}
```

**`stdout` is always the snapshot** (the full accessibility tree of the current page after the action). Your AI agent reads this to know what elements are available next.

---

### `GET /mariner/session/:id/status`
**Check if a session is alive.**

```
GET /mariner/session/my-session-abc123/status
```

**Response:**
```json
{
  "success": true,
  "ready": true,
  "sessionId": "my-session-abc123",
  "socketReady": true,
  "daemonAlive": true,
  "pid": 45678
}
```

Use this to poll after `session/start` if you don't have a callback URL, or to check health before sending commands.

---

### `POST /mariner/session/stop`
**Gracefully close a browser session.**

**Request:**
```json
{
  "sessionId": "my-session-abc123",
  "executionId": "exec-uuid-here"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "my-session-abc123",
  "message": "stopped",
  "durationMs": 1200
}
```

---

## Command Reference

All commands go into the `raw_command` field. Replace `<SESSION>` with your actual sessionId.

---

### `snapshot` — Read the current page
```
node /data/browser-cli/exec.js snapshot --session <SESSION>
```
Returns the full accessibility tree. **Always call this first** after starting a session or navigating to a new page.

---

### `act` — Interact with an element
```
node /data/browser-cli/exec.js act --session <SESSION> --ref <eN> --kind <click|fill|type|check|press> [--text "value"]
```

| `--kind` | Use for | `--text` required? |
|----------|---------|-------------------|
| `click` | Buttons, links, any clickable | No |
| `fill` | Input fields, text areas | Yes — the value to type |
| `type` | Type without clearing first | Yes — the text to type |
| `check` | Checkboxes | No |
| `press` | Key press on focused element | Yes — key name (e.g. `Enter`) |

**Example — click a button:**
```
node /data/browser-cli/exec.js act --session abc123 --ref e5 --kind click
```

**Example — fill a text field:**
```
node /data/browser-cli/exec.js act --session abc123 --ref e12 --kind fill --text "john.doe@email.com"
```

The `--ref` value comes from the snapshot output (e.g. `ref=e12  textbox  "Email"`).

---

### `navigate` — Go to a URL
```
node /data/browser-cli/exec.js navigate --session <SESSION> --url "https://www.linkedin.com"
```
The humanizer adds a 25% chance of a brief exploratory detour before arriving at the target URL (simulates organic navigation).

---

### `scroll` — Scroll the page
```
node /data/browser-cli/exec.js scroll --session <SESSION> --pixels 600 --direction down
```
`--direction`: `up` or `down`. The humanizer varies the scroll amount automatically for anti-detection.

---

### `screenshot` — Take a screenshot
```
node /data/browser-cli/exec.js screenshot --session <SESSION>
```
Set `expectScreenshot: true` in the request body to receive the image as base64 in the response.

---

### `get-text` — Get raw page text
```
node /data/browser-cli/exec.js get-text --session <SESSION>
```
Returns up to 8000 chars of visible page text. Useful for reading content without parsing the A11y tree.

---

### `wait` — Pause execution
```
node /data/browser-cli/exec.js wait --session <SESSION> --ms 2000
```
Use when you need to wait for a page load or AJAX response. The humanizer already handles micro-delays between actions — only use `wait` when the page visibly needs time to load.

---

### `open-tab` — Open a new tab
```
node /data/browser-cli/exec.js open-tab --session <SESSION> --url "https://google.com"
```

---

### `switch-tab` — Switch to a tab
```
node /data/browser-cli/exec.js switch-tab --session <SESSION> --tab tab-1
```
Tab IDs come from `open-tab` responses or the `status` command.

---

### `close-tab` — Close current tab
```
node /data/browser-cli/exec.js close-tab --session <SESSION>
```

---

### `press-key` — Press a keyboard key
```
node /data/browser-cli/exec.js press-key --session <SESSION> --key Enter
```
Common keys: `Enter`, `Tab`, `Escape`, `ArrowDown`, `ArrowUp`, `Backspace`, `Space`

---

### `detect-captcha` — Check for captcha
```
node /data/browser-cli/exec.js detect-captcha --session <SESSION>
```
Returns: `{ found: true, type: "recaptcha2", siteKey: "6Lc..." }` or `{ found: false }`
Detects: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, FunCaptcha

---

### `inject-captcha-token` — Solve captcha
```
node /data/browser-cli/exec.js inject-captcha-token --session <SESSION> --token "<solved-token>" --captcha-type recaptcha2
```
`--captcha-type`: `recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`, `funcaptcha`

---

### `checkpoint` — Mark task progress
```
node /data/browser-cli/exec.js checkpoint --session <SESSION> --task "linkedin-login" --status done --note "Logged in successfully"
```
`--status`: `done` or `failed`. Used for session logging and recovery.

---

### `status` — Get full session info
```
node /data/browser-cli/exec.js status --session <SESSION>
```
Returns: session ID, account, platform, daemon PID, all open tabs with URLs, completed/pending task lists.

---

### `stop` — End the session
```
node /data/browser-cli/exec.js stop --session <SESSION>
```
Closes the session daemon. Also call `POST /mariner/session/stop` to close the MLX browser profile.

---

## Full Session Lifecycle

```
1. POST /mariner/session/start  → wait for callback (session_ready)
2. POST /mariner/execute        → snapshot (read page)
3. POST /mariner/execute        → navigate / act / fill (do work)
4. POST /mariner/execute        → snapshot (confirm result)
5. ... repeat steps 3-4 for each task ...
6. POST /mariner/session/stop   → clean up
```

---

## Example: LinkedIn Login Flow

```javascript
// Step 1: Take initial snapshot
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js snapshot --session ses-abc123"
}
// → stdout: "ref=e1 button \"Sign in\" ..."

// Step 2: Navigate to LinkedIn
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js navigate --session ses-abc123 --url \"https://www.linkedin.com/login\""
}
// → stdout: snapshot of login page

// Step 3: Fill email (snapshot showed ref=e3 is the email field)
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js act --session ses-abc123 --ref e3 --kind fill --text \"john@email.com\""
}
// → stdout: updated snapshot

// Step 4: Fill password (ref=e4 is password field)
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js act --session ses-abc123 --ref e4 --kind fill --text \"SecurePass123!\""
}

// Step 5: Click Sign In button (ref=e7)
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js act --session ses-abc123 --ref e7 --kind click"
}
// → stdout: snapshot of LinkedIn feed (logged in!)

// Step 6: Checkpoint
POST /mariner/execute
{
  "sessionId": "ses-abc123",
  "raw_command": "node /data/browser-cli/exec.js checkpoint --session ses-abc123 --task \"linkedin-login\" --status done"
}
```

---

## How Humanization Works (What Happens Automatically)

When you call `/mariner/execute` with a raw command, here is what actually happens before anything touches the browser:

**Level 1 — Decision layer (Gate, before execution):**
- Picks a session persona: `careful` / `fast` / `distracted` / `professional`
- Computes a pre-action idle delay (120ms–7000ms) based on persona and history
- Enforces anti-patterns: no two delays within 100ms of each other, no monotone trends
- 22% chance of "reading pause" (2000–5000ms) every ~5 actions
- 8% chance of distraction spike (3000–7000ms) in distracted persona
- For scroll commands: picks a humanized scroll amount (500–700px) varied per session
- For typing: tracks typo rate (0–14%), prevents 3+ consecutive typos

**Level 2 — Physics layer (Session daemon, inside Playwright):**
- **Mouse:** De Casteljau Bézier curves with 2–4 random control points, Gaussian speed (40–85 px/s), final position offset 5–15px from element center
- **Click:** 200–500ms hover hesitation before pressing
- **Typing:** Per-key Gaussian delays, 20 FAST_PAIRS for common bigrams (th, he, in...), 6.5% error rate → adjacent mistype → 600–1500ms "realization" → backspace → retype
- **Scroll:** Decelerating bursts (6–10 steps, triangular weighting), 600–3500ms reading dwell between bursts
- **Navigation:** 25% chance of exploratory detour to domain root/about/blog first

**You send one command. The VPS does all of this. You get back a snapshot.**

---

## Snapshot Format

```
=== SNAPSHOT ===
URL: https://www.linkedin.com/login
Title: LinkedIn Login
Elements (34):
ref=e1  heading  "LinkedIn"
ref=e2  textbox  "Email or phone"
ref=e3  textbox  "Password"
ref=e4  button  "Sign in"
ref=e5  link  "Forgot password?"
ref=e6  link  "New to LinkedIn? Join now"
=== END SNAPSHOT ===
```

Each line: `ref=eN  role  "name"  [value="..."]  [checked=true/false]  [disabled]`

Your AI agent reads this, picks the right `ref`, and sends the next command.

---

## Security Notes

- All commands are validated against an allowlist: only `node /data/browser-cli/exec.js` and a few other `/data/` paths are accepted
- Shell metacharacters (`; & | \` $ > <`) are rejected outside of quoted strings
- Rate limit: 120 requests/minute per IP
- Bearer token required on all endpoints except `/health`
- Only HTTPS callback URLs are accepted

---

## Environment Variables (Already Configured on VPS)

| Variable | Value |
|----------|-------|
| `GATE_SECRET` | `3a9c5d4e7f8b1236e45a7c9f0b1d2e3f` |
| `GATE_PORT` | `4567` |
| `MARINER_API_TOKEN` | `3a9c5d4e7f8b1236e45a7c9f0b1d2e3f` |

The `GATE_SECRET` is what you put in `Authorization: Bearer <secret>`.

---

## Quick Test (curl)

```bash
# Health check
curl http://187.77.141.181:4567/health

# Start a session
curl -X POST http://187.77.141.181:4567/mariner/session/start \
  -H "Authorization: Bearer 3a9c5d4e7f8b1236e45a7c9f0b1d2e3f" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"john-doe","platform":"linkedin","callbackUrl":"https://your-project.supabase.co/functions/v1/mariner-callback"}'

# Execute a snapshot (replace SESSION_ID with the one from above)
curl -X POST http://187.77.141.181:4567/mariner/execute \
  -H "Authorization: Bearer 3a9c5d4e7f8b1236e45a7c9f0b1d2e3f" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"SESSION_ID","raw_command":"node /data/browser-cli/exec.js snapshot --session SESSION_ID"}'
```

---

*Gate version: 2026-03-17 — Slicer-Relay Gate with full humanization pipeline*
