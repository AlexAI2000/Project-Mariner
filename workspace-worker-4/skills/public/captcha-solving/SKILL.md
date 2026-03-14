---
name: captcha-solving
description: "Solve CAPTCHAs encountered in the browser using the 2Captcha API with MultiLogin X proxy routing. Use this skill whenever a CAPTCHA appears during any browser automation task."
triggers:
  - captcha
  - recaptcha
  - hcaptcha
  - solve captcha
  - verify you are human
---

# CAPTCHA Solving Skill

## When to Use This Skill
- Any time you see a CAPTCHA, reCAPTCHA, hCaptcha, Arkose/FunCaptcha challenge, or Cloudflare Turnstile
- After navigating to a page and detecting a CAPTCHA block
- During account creation (Outlook, LinkedIn, etc.) when a CAPTCHA appears

## Full Workflow

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
Returns: `{ found: true, type: "recaptcha2", siteKey: "6Lc..." }`

If `found` is false, no CAPTCHA detected — proceed normally.

### Step 2 — Solve via 2Captcha API
```bash
node /data/captcha/solve-captcha.js \
  --type <CAPTCHA_TYPE> \
  --site-key <SITE_KEY> \
  --url <PAGE_URL> \
  --client-id <CLIENT_ID>
```

**Type mapping from detectCaptcha:**
| detectCaptcha type | --type flag |
|--------------------|-------------|
| recaptcha2         | recaptcha2  |
| recaptcha3         | recaptcha3  |
| hcaptcha           | hcaptcha    |
| funcaptcha         | funcaptcha  |
| turnstile          | turnstile   |

**Returns:** `{ "success": true, "token": "03ADUVZw..." }`

Wait: reCAPTCHA takes ~20s, hCaptcha ~15s, FunCaptcha ~30s.

### Step 3 — Inject Token into Page
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "<PLATFORM>",
  "steps": [
    {"action": "injectCaptchaToken", "token": "<TOKEN_FROM_STEP_2>", "captchaType": "<TYPE>"},
    {"action": "wait", "ms": 1000},
    {"action": "click", "selector": "<SUBMIT_BUTTON_SELECTOR>"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Step 4 — Verify Success
Check page text: if CAPTCHA error still shows, retry from Step 1 (max 3 attempts).

## CAPTCHA Type Reference

### reCAPTCHA v2 (most common)
- Appears as: checkbox "I'm not a robot" or image selection challenge
- Command: `--type recaptcha2 --site-key <key> --url <url>`
- Solution field: `token`

### hCaptcha
- Appears as: hCaptcha image challenge (similar to reCAPTCHA)
- Command: `--type hcaptcha --site-key <key> --url <url>`

### FunCaptcha / Arkose Labs
- Appears as: puzzle/rotation challenge (Microsoft uses this)
- Microsoft Outlook public key: `B7D8911C-5CC8-A9A3-35B0-554ACEE604DA`
- Command: `--type funcaptcha --site-key B7D8911C-5CC8-A9A3-35B0-554ACEE604DA --url https://signup.live.com`

### Cloudflare Turnstile
- Appears as: Cloudflare verification widget
- Command: `--type turnstile --site-key <key> --url <url>`

## Quick Commands Reference
```bash
# Detect CAPTCHA on current page (in dispatch step)
{"action": "detectCaptcha"}

# Solve reCAPTCHA v2
node /data/captcha/solve-captcha.js --type recaptcha2 --site-key SITE_KEY --url PAGE_URL --client-id CLIENT_ID

# Solve Microsoft FunCaptcha
node /data/captcha/solve-captcha.js --type funcaptcha --site-key B7D8911C-5CC8-A9A3-35B0-554ACEE604DA --url https://signup.live.com --client-id CLIENT_ID

# Inject token (in dispatch step)
{"action": "injectCaptchaToken", "token": "TOKEN_HERE", "captchaType": "recaptcha2"}
```
