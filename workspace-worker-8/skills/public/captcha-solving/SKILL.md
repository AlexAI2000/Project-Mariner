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

# CAPTCHA Solving — Dispatch Path

This skill applies when you use `node /data/director/dispatch.js` for browser
automation (general workers: worker-1 through worker-10).

---

## RECOGNITION — STOP and use this skill when you see ANY of:

### HTML Signatures (in accessibility tree / page source)
- `.g-recaptcha`, `div[data-sitekey]`, `[data-callback]` → **reCAPTCHA v2**
- `iframe[title*="reCAPTCHA"]`, `iframe[name*="a-"]` → **reCAPTCHA v2 challenge iframe**
- `script[src*="recaptcha/api.js"]` with `render=KEY` param → **reCAPTCHA v3** (invisible)
- `.h-captcha`, `[data-hcaptcha-sitekey]`, `iframe[src*="hcaptcha.com"]` → **hCaptcha**
- `iframe[src*="funcaptcha"]`, `iframe[src*="arkoselabs"]`, `#FunCaptcha`, `[id*="arkose"]` → **FunCaptcha/Arkose Labs**
- `script[src*="turnstile"]`, `.cf-turnstile`, Cloudflare interstitial page → **Cloudflare Turnstile**

### Text Patterns (in page text from getPageText step)
- "Please verify you are a human" / "Verify you are human"
- "I'm not a robot" / "Prove you are human"
- "Security check" / "Please complete the security check"
- "Checking if the site connection is secure"
- "Please stand by, while we are checking your browser"
- "One more step" / "Before you continue" (Google interstitials)
- "challenge_running" (Cloudflare JS challenge marker)
- "Press & Hold" / "Slide to verify" / "Move the slider"

---

## FULL WORKFLOW

### Step 1 — Detect CAPTCHA Type and Site Key

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "<PLATFORM>",
  "steps": [
    {"action": "detectCaptcha"}
  ]
}' --timeout 30
```

**Returns:** `{ found: true, type: "recaptcha2", siteKey: "6Lc..." }`

If `found: false` but CAPTCHA is visually apparent, take a screenshot:
```bash
node /data/director/dispatch.js '{"mlProfileId":"...","clientId":"...","platform":"...","steps":[{"action":"screenshot","path":"/tmp/captcha-check.png"},{"action":"getPageText"}]}' --timeout 30
```

---

### Step 2 — Log Before Solving (CRITICAL for crash recovery)

Write a note to your workspace memory immediately:
```
memory/captcha-state.json:
{
  "captchaDetected": true,
  "type": "recaptcha2",
  "siteKey": "6Lc...",
  "url": "https://...",
  "ts": 1234567890
}
```

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
{"success":true,"token":"03ADUVZwXXX...","taskId":123456789}
```

**Expected solve times:**
| Type        | Typical wait |
|-------------|-------------|
| recaptcha2  | 15–30s      |
| recaptcha3  | 8–15s       |
| hcaptcha    | 10–20s      |
| funcaptcha  | 20–40s      |
| turnstile   | 3–8s        |

**Error handling:**

| Error                      | Action                                   |
|----------------------------|------------------------------------------|
| `ERROR_NO_SLOT_AVAILABLE`  | Wait 30s, retry once                     |
| `ERROR_ZERO_BALANCE`       | Stop — write to memory, skip task        |
| `ERROR_CAPTCHA_UNSOLVABLE` | Retry once. If fails again, skip task    |
| Timeout (6 min)            | Resubmit fresh call                      |

---

### Step 4 — Inject Token

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "<PLATFORM>",
  "steps": [
    {"action": "injectCaptchaToken", "token": "<TOKEN>", "captchaType": "<TYPE>"},
    {"action": "wait", "ms": 1500},
    {"action": "click", "selector": "<SUBMIT_BUTTON_SELECTOR>"},
    {"action": "wait", "ms": 2500},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Step 5 — Verify Success

Check getPageText output: CAPTCHA text gone = success.
If CAPTCHA still present: retry from Step 1 (max 3 attempts).

---

## TIMEOUT RECOVERY

If session resumes and `memory/captcha-state.json` exists:
1. Re-detect CAPTCHA on current page (`detectCaptcha` step)
2. If still there → solve again from Step 3
3. If gone → proceed normally, clean up captcha-state.json

---

## CAPTCHA TYPE REFERENCE

| Type         | `--type` flag | Trigger signals                            | SiteKey location              |
|--------------|---------------|--------------------------------------------|-------------------------------|
| `recaptcha2` | recaptcha2    | `.g-recaptcha`, checkbox, image grid       | `data-sitekey` attribute      |
| `recaptcha3` | recaptcha3    | Invisible, `api.js?render=KEY`             | Script URL param              |
| `hcaptcha`   | hcaptcha      | `.h-captcha`, hCaptcha image puzzle        | `data-sitekey` attribute      |
| `funcaptcha` | funcaptcha    | Arkose iframe, rotation puzzle             | Use known key below           |
| `turnstile`  | turnstile     | `.cf-turnstile`, Cloudflare interstitial   | `data-sitekey` attribute      |

### Known Public Keys
| Platform                        | Type        | Public Key                               |
|---------------------------------|-------------|------------------------------------------|
| Microsoft (Outlook/Live/signup) | funcaptcha  | `B7D8911C-5CC8-A9A3-35B0-554ACEE604DA`  |
| Twitter / X                     | funcaptcha  | `2CB16598-CB82-4CF7-B332-5990DB66F3AB`  |

---

## QUICK COMMAND REFERENCE

```bash
# Detect
{"action": "detectCaptcha"}

# Inject (in dispatch steps)
{"action": "injectCaptchaToken", "token": "TOKEN_HERE", "captchaType": "recaptcha2"}

# Solve reCAPTCHA v2
node /data/captcha/solve-captcha.js --type recaptcha2 --site-key SITEKEY --url PAGE_URL --client-id CLIENT_ID

# Solve Microsoft FunCaptcha (Outlook account creation)
node /data/captcha/solve-captcha.js --type funcaptcha --site-key B7D8911C-5CC8-A9A3-35B0-554ACEE604DA --url https://signup.live.com --client-id CLIENT_ID

# Solve Twitter/X FunCaptcha
node /data/captcha/solve-captcha.js --type funcaptcha --site-key 2CB16598-CB82-4CF7-B332-5990DB66F3AB --url https://twitter.com --client-id CLIENT_ID

# Solve image CAPTCHA
node /data/captcha/solve-captcha.js --type image --image-b64 BASE64DATA
```
