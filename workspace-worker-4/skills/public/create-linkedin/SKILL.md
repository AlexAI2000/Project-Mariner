---
name: create-linkedin
description: "Create a new LinkedIn account for a client from scratch. Requires a valid email address (Outlook created or provided). Handles email verification, CAPTCHA solving, and saves credentials."
triggers:
  - create linkedin account
  - sign up linkedin
  - new linkedin account
  - linkedin signup
---

# LinkedIn Account Creation Skill

## Prerequisites
- Client has an email address in `clients.json` (either pre-existing or just created via create-outlook skill)
- `pa-lookup.js` output has `mlProfileId` for linkedin platform
- If `credentials.linkedin` already exists → account already created, use setup skill instead

## Pre-Flight Check
```bash
node /data/executor/pa-lookup.js <clientId> linkedin
```
- If `credentials.linkedin` is not null → account EXISTS. Use LinkedIn profile SETUP, not creation.
- If `email` is null → create Outlook first (see create-outlook skill)

## Full Browser Workflow

### Phase 1 — Generate Credentials
```bash
# Generate a unique LinkedIn password
node /data/accounts/generate-password.js --length 16
# → { "password": "NewPass456@" }
```

### Phase 2 — Open LinkedIn Signup
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/signup"},
    {"action": "wait", "ms": 3000},
    {"action": "screenshot", "path": "/tmp/<CLIENT_ID>-linkedin-signup.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 3 — Fill Email
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "click", "selector": "input#email-address, input[name=email-address], input[autocomplete=email]"},
    {"action": "type", "text": "<CLIENT_EMAIL>"},
    {"action": "click", "selector": "button[data-id=join-form-submit], button[aria-label*=Continue], button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 4 — Set Password
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "click", "selector": "input[name=password], input#password"},
    {"action": "type", "text": "<LINKEDIN_PASSWORD>"},
    {"action": "click", "selector": "button[type=submit], button[data-id=join-form-submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 5 — Fill Name
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "click", "selector": "input[name=firstName], input[id*=firstName]"},
    {"action": "type", "text": "<FIRST_NAME>"},
    {"action": "click", "selector": "input[name=lastName], input[id*=lastName]"},
    {"action": "type", "text": "<LAST_NAME>"},
    {"action": "click", "selector": "button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "detectCaptcha"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 6 — Solve CAPTCHA (if detected)
```bash
# LinkedIn uses reCAPTCHA v2 or hCaptcha typically
node /data/captcha/solve-captcha.js \
  --type recaptcha2 \
  --site-key <SITE_KEY_FROM_DETECT> \
  --url https://www.linkedin.com/signup \
  --client-id <CLIENT_ID>
# Then inject token and submit
```

### Phase 7 — Email Verification (LinkedIn sends OTP)
LinkedIn sends a 6-digit code to the email address. You must:
1. Open a new tab and go to Outlook to retrieve the code
2. Return to LinkedIn and enter the code

```bash
# Step 7a: Open Outlook in same browser session
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "openTab", "url": "https://outlook.live.com/mail/"},
    {"action": "wait", "ms": 5000},
    {"action": "screenshot", "path": "/tmp/<CLIENT_ID>-outlook-inbox.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
# → Find the LinkedIn verification code in page text (6 digits)

# Step 7b: Log into Outlook if needed (use email credentials from pa-lookup)
# If Outlook asks for login:
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "goto", "url": "https://login.live.com"},
    {"action": "click", "selector": "input[type=email], input[name=loginfmt]"},
    {"action": "type", "text": "<OUTLOOK_EMAIL>"},
    {"action": "click", "selector": "input[type=submit], button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "input[type=password], input[name=passwd]"},
    {"action": "type", "text": "<OUTLOOK_PASSWORD>"},
    {"action": "click", "selector": "input[type=submit], button[type=submit]"},
    {"action": "wait", "ms": 4000},
    {"action": "goto", "url": "https://outlook.live.com/mail/"},
    {"action": "wait", "ms": 5000},
    {"action": "getPageText"}
  ]
}' --timeout 120

# Step 7c: Enter verification code back on LinkedIn
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "linkedin",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 30
# Find the verification code input and enter the code
```

### Phase 8 — Complete Profile Basics
After email verification, LinkedIn may ask for:
- Job title / experience level → enter from client briefing
- Skip optional steps when possible (look for "Skip" links)

### Phase 9 — Save Credentials Immediately
```bash
node /data/accounts/save-credentials.js <clientId> linkedin '{
  "email": "<EMAIL>",
  "password": "<LINKEDIN_PASSWORD>",
  "accountUrl": "https://linkedin.com/in/me/"
}'
```
**Save IMMEDIATELY after account creation — before doing any profile setup.**

## After LinkedIn Account Created
Report: "LinkedIn account created for <clientId>. Login: <email>, saved to clients.json. Account URL: linkedin.com/in/me/ — ready for profile setup by sm-linkedin agent."

Then notify Director so they can trigger sm-linkedin for full profile setup.

## Common Issues
| Issue | Fix |
|-------|-----|
| "Email already on LinkedIn" | Client already has account — use login instead |
| CAPTCHA loop | Wait 60s, use proxyless solve attempt |
| Email code not in inbox | Wait 30s and reload Outlook inbox |
| LinkedIn asks for phone | If client has phone in clients.json: use it. Else report to Director. |
| Rate limited | Wait 5 minutes, retry in a new session |
