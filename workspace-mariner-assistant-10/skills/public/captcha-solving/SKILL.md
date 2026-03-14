---
name: captcha-solving
description: "Detect and solve CAPTCHAs (reCAPTCHA v2/v3, hCaptcha, FunCaptcha/Arkose, Cloudflare Turnstile, image) using the 2Captcha API. Trigger immediately when any verification challenge or bot-detection wall appears."
triggers:
  - captcha
  - recaptcha
  - hcaptcha
  - arkose
  - funcaptcha
  - turnstile
  - cloudflare challenge
  - verify you are human
  - not a robot
  - security check
  - prove you are human
  - checking your browser
  - before you continue
---

# CAPTCHA Solving — Browser-CLI Path

This skill applies when you use `browser-cli/exec.js` for browser automation
(social media agents: LinkedIn, Instagram, Facebook, Twitter, and any other
browser-CLI session).

---

## RECOGNITION — STOP and use this skill when you see ANY of:

### HTML Signatures (visible in snapshot refs or page source)
- `.g-recaptcha`, `div[data-sitekey]`, `[data-callback]` → **reCAPTCHA v2**
- `iframe[title*="reCAPTCHA"]`, `iframe[name*="a-"]` → **reCAPTCHA v2 challenge iframe**
- `script[src*="recaptcha/api.js"]` with `render=KEY` param → **reCAPTCHA v3** (invisible)
- `.h-captcha`, `[data-hcaptcha-sitekey]`, `iframe[src*="hcaptcha.com"]` → **hCaptcha**
- `iframe[src*="funcaptcha"]`, `iframe[src*="arkoselabs"]`, `#FunCaptcha`, `[id*="arkose"]` → **FunCaptcha/Arkose Labs**
- `script[src*="turnstile"]`, `.cf-turnstile`, full Cloudflare interstitial → **Cloudflare Turnstile**
- `iframe[title*="hCaptcha"]`, any blocked-content overlay

### Text Patterns (in snapshot text or get-text output)
- "Please verify you are a human" / "Verify you are human"
- "I'm not a robot" / "I am not a robot" / "Prove you are human"
- "Security check" / "Security verification" / "Please complete the security check"
- "Checking if the site connection is secure"
- "Please stand by, while we are checking your browser"
- "One more step" (Google interstitial)
- "Before you continue" (Google sign-in interstitial)
- "challenge_running" / "cf_chl_opt" (Cloudflare JS challenge markers)
- "Press & Hold" (some newer bot challenges)
- "Slide to verify" / "Move the slider"

### Visual Indicators (from screenshot)
- Checkbox "I'm not a robot" label
- Image grid selection puzzle (traffic lights, crosswalks, bicycles)
- Rotating image or slider puzzle (FunCaptcha)
- Cloudflare "Checking your browser…" spinner / orange shield page
- Any modal/overlay that blocks all page interaction
- Text field asking to type distorted characters

---

## FULL WORKFLOW

### Step 1 — Detect CAPTCHA

```bash
node /data/browser-cli/exec.js detect-captcha --session $SESSION_ID
```

**Returns:**
```
CAPTCHA DETECTED on https://example.com/signup
  Type:    recaptcha2
  SiteKey: 6LcXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

If `No CAPTCHA detected` but you visually see one:
```bash
# Screenshot to inspect
node /data/browser-cli/exec.js screenshot --session $SESSION_ID --path /tmp/captcha-debug.png
# Get all page text
node /data/browser-cli/exec.js get-text --session $SESSION_ID
```

For **FunCaptcha/Arkose**: siteKey may be null from auto-detect. Use the known
public key for the platform (see Type Reference below).

---

### Step 2 — Log Before Solving (CRITICAL for crash recovery)

```bash
node /data/browser-cli/exec.js checkpoint \
  --session $SESSION_ID \
  --task captcha_in_progress \
  --status failed \
  --note "CAPTCHA detected: type=recaptcha2 siteKey=6Lc... url=https://..."
```

This creates a recoverable marker in the JSONL log. If the agent crashes or
times out during solving, on resume check the log for `captcha_in_progress`
and re-detect on the current page.

---

### Step 3 — Solve via 2Captcha API

```bash
node /data/captcha/solve-captcha.js \
  --type <TYPE> \
  --site-key <SITE_KEY> \
  --url <PAGE_URL> \
  --client-id <CLIENT_ID>
```

**Output on success:**
```json
{"success":true,"token":"03ADUVZwXXXXXXXX...","taskId":123456789}
```

**Expected solve times:**
| Type        | Typical wait |
|-------------|-------------|
| recaptcha2  | 15–30s      |
| recaptcha3  | 8–15s       |
| hcaptcha    | 10–20s      |
| funcaptcha  | 20–40s      |
| turnstile   | 3–8s        |

**On failure:**

| Error message                | Action                                      |
|------------------------------|---------------------------------------------|
| `ERROR_NO_SLOT_AVAILABLE`    | Wait 30s, retry once                        |
| `ERROR_ZERO_BALANCE`         | Stop — log checkpoint `captcha_failed:no_balance`, skip task |
| `ERROR_CAPTCHA_UNSOLVABLE`   | Retry once. If fails again, checkpoint `captcha_failed:unsolvable` |
| `ERROR_TOO_BIG_CAPTCHA_FILESIZE` | Image type only — compress or skip     |
| Timeout after 3 min          | Resubmit fresh call                         |

---

### Step 4 — Inject Token

```bash
node /data/browser-cli/exec.js inject-captcha-token \
  --session $SESSION_ID \
  --token "<TOKEN_FROM_STEP_3>" \
  --captcha-type <TYPE>
```

The daemon injects the token into the page's hidden fields and fires the
CAPTCHA's own callback functions. It also adds a human-like 800–1500ms pause
automatically.

---

### Step 5 — Human Pause + Find Submit Button

```bash
# Extra wait (humanized feel — 1–2 seconds)
node /data/browser-cli/exec.js wait --session $SESSION_ID --ms 1500

# Snapshot to find the submit/verify/continue button
node /data/browser-cli/exec.js snapshot --session $SESSION_ID
# → Read refs, identify the submit button ref (e.g., button "Verify", "Continue", "Next")

node /data/browser-cli/exec.js act --session $SESSION_ID --ref <REF> --kind click

# Wait for page to process
node /data/browser-cli/exec.js wait --session $SESSION_ID --ms 2500
```

---

### Step 6 — Verify Success + Log

```bash
node /data/browser-cli/exec.js get-text --session $SESSION_ID
```

Check: CAPTCHA text is gone, page has progressed. Then log:

```bash
node /data/browser-cli/exec.js checkpoint \
  --session $SESSION_ID \
  --task captcha_solved \
  --status done \
  --note "CAPTCHA solved: type=recaptcha2 — page proceeded to next step"
```

If CAPTCHA **still present** after injection + submit:
- Wait 5s, re-detect, retry from Step 3 (max 3 attempts total)
- On 3rd failure: checkpoint `captcha_failed:max_retries`, report to session log

---

## TIMEOUT RECOVERY

When resuming a session and you find `captcha_in_progress` in the JSONL log:

1. **Re-detect on current page** — `detect-captcha`
2. If CAPTCHA **still there** → solve again from Step 3 (submit fresh 2Captcha task)
3. If CAPTCHA **gone** → page may have already accepted it, proceed normally
4. If page is blank or errored → navigate back to the original URL and re-attempt

---

## CAPTCHA TYPE REFERENCE

| Type         | `--type` flag | Trigger signals                                         | SiteKey location              |
|--------------|---------------|---------------------------------------------------------|-------------------------------|
| `recaptcha2` | recaptcha2    | `.g-recaptcha`, checkbox, image grid                    | `data-sitekey` attribute      |
| `recaptcha3` | recaptcha3    | Invisible, `api.js?render=KEY`                          | Script URL param              |
| `hcaptcha`   | hcaptcha      | `.h-captcha`, hCaptcha image puzzle                     | `data-sitekey` attribute      |
| `funcaptcha` | funcaptcha    | Arkose iframe, puzzle/rotation, Microsoft accounts      | Use known key below           |
| `turnstile`  | turnstile     | `.cf-turnstile`, Cloudflare interstitial                | `data-sitekey` attribute      |
| `image`      | image         | Simple text/distorted-letter image (use `--image-b64`) | N/A                           |

### Known Public Keys
| Platform                        | Type        | Public Key                               |
|---------------------------------|-------------|------------------------------------------|
| Microsoft (Outlook/Live/signup) | funcaptcha  | `B7D8911C-5CC8-A9A3-35B0-554ACEE604DA`  |
| Microsoft Teams                 | funcaptcha  | `B7D8911C-5CC8-A9A3-35B0-554ACEE604DA`  |
| LinkedIn (rare)                 | recaptcha2  | Auto-detected via `data-sitekey`         |
| Instagram                       | recaptcha2  | Auto-detected via `data-sitekey`         |
| Facebook                        | recaptcha2  | Auto-detected via `data-sitekey`         |
| Twitter / X                     | funcaptcha  | `2CB16598-CB82-4CF7-B332-5990DB66F3AB`  |

---

## QUICK COMMAND REFERENCE

```bash
# Detect CAPTCHA on current page
node /data/browser-cli/exec.js detect-captcha --session $SESSION_ID

# Solve reCAPTCHA v2
node /data/captcha/solve-captcha.js --type recaptcha2 --site-key SITEKEY --url PAGE_URL --client-id CLIENT_ID

# Solve Microsoft FunCaptcha (Outlook account creation)
node /data/captcha/solve-captcha.js --type funcaptcha --site-key B7D8911C-5CC8-A9A3-35B0-554ACEE604DA --url https://signup.live.com --client-id CLIENT_ID

# Solve Twitter/X FunCaptcha
node /data/captcha/solve-captcha.js --type funcaptcha --site-key 2CB16598-CB82-4CF7-B332-5990DB66F3AB --url https://twitter.com --client-id CLIENT_ID

# Inject token
node /data/browser-cli/exec.js inject-captcha-token --session $SESSION_ID --token TOKEN --captcha-type recaptcha2

# Solve image CAPTCHA (base64 image data from screenshot)
node /data/captcha/solve-captcha.js --type image --image-b64 BASE64DATA
```
