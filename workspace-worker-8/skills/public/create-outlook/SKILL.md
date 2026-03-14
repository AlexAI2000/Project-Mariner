---
name: create-outlook
description: "Create a new Microsoft Outlook email account for a client. Use this when a client has no email address stored and needs one created before signing up for social media platforms."
triggers:
  - create email
  - create outlook
  - create microsoft account
  - no email
  - need email address
---

# Microsoft Outlook Account Creation Skill

## When to Use
- `pa-lookup.js` returns `"email": null` for the client
- Director instructs you to create an Outlook account before social media signup
- User asks Olaf to create social media accounts for a new client

## Pre-Flight Checks
```bash
# 1. Get client info (includes MultiLogin X profile for the platform)
node /data/executor/pa-lookup.js <clientId> linkedin

# 2. Generate a password for the new account
node /data/accounts/generate-password.js --length 18
# → { "password": "SecurePass123!" }

# 3. Decide on email username
# Format: firstname.lastname.XXXX@outlook.com (XXXX = 4 random digits)
# Example: john.doe.4821@outlook.com
```

## Full Browser Workflow

### Phase 1 — Open Signup Page
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "outlook",
  "steps": [
    {"action": "goto", "url": "https://signup.live.com/signup"},
    {"action": "wait", "ms": 3000},
    {"action": "screenshot", "path": "/tmp/<CLIENT_ID>-outlook-signup.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 2 — Fill Email Field
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "outlook",
  "steps": [
    {"action": "click", "selector": "input[name=MemberName], input[id=MemberName], input[placeholder*=email], input[type=email]"},
    {"action": "type", "text": "<CHOSEN_EMAIL>@outlook.com"},
    {"action": "click", "selector": "input[id=iSignupAction], button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```
If page says "already taken": try a different username (add more random digits).

### Phase 3 — Set Password
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "outlook",
  "steps": [
    {"action": "click", "selector": "input[name=Password], input[id=Password], input[type=password]"},
    {"action": "type", "text": "<GENERATED_PASSWORD>"},
    {"action": "click", "selector": "input[id=iSignupAction], button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 4 — Fill Name Fields
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "outlook",
  "steps": [
    {"action": "click", "selector": "input[name=FirstName], input[id=FirstName]"},
    {"action": "type", "text": "<CLIENT_FIRST_NAME>"},
    {"action": "click", "selector": "input[name=LastName], input[id=LastName]"},
    {"action": "type", "text": "<CLIENT_LAST_NAME>"},
    {"action": "click", "selector": "input[id=iSignupAction], button[type=submit]"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 5 — Fill Birthdate
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "<CLIENT_ID>",
  "platform": "outlook",
  "steps": [
    {"action": "click", "selector": "select[name=BirthMonth], select[id=BirthMonth]"},
    {"action": "type", "text": "6"},
    {"action": "click", "selector": "input[name=BirthDay], input[id=BirthDay]"},
    {"action": "type", "text": "15"},
    {"action": "click", "selector": "select[name=BirthYear], input[id=BirthYear]"},
    {"action": "type", "text": "1988"},
    {"action": "click", "selector": "input[id=iSignupAction], button[type=submit]"},
    {"action": "wait", "ms": 3000},
    {"action": "screenshot", "path": "/tmp/<CLIENT_ID>-outlook-after-birthday.png"},
    {"action": "detectCaptcha"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

### Phase 6 — Solve CAPTCHA (if detected)
If `detectCaptcha` returned `found: true`:
```bash
# For Microsoft FunCaptcha (most common on Outlook signup):
node /data/captcha/solve-captcha.js \
  --type funcaptcha \
  --site-key B7D8911C-5CC8-A9A3-35B0-554ACEE604DA \
  --url https://signup.live.com \
  --client-id <CLIENT_ID>
```
Then inject the token and submit.

### Phase 7 — Handle Phone/Email Verification
After CAPTCHA, Microsoft may ask for phone verification:
- Check page text for "phone", "verify", "code"
- If phone verification required:
  - Check `pa-lookup` result for `phone` field
  - If phone exists: enter it, get SMS code
  - If no phone: **STOP, report to Director**: "Phone verification required for creating Outlook account for <clientId>. Please provide a phone number via: node /data/accounts/save-credentials.js <clientId> phone '\"+31612345678\"\'"
  - Do NOT continue without verification

### Phase 8 — Save Credentials Immediately
As soon as account is created successfully:
```bash
node /data/accounts/save-credentials.js <clientId> email '{
  "provider": "outlook",
  "address": "<EMAIL>@outlook.com",
  "password": "<PASSWORD>"
}'
```
**Always save IMMEDIATELY** — if the session dies after this, the credentials are preserved.

## Success Indicators
Page text contains: "Account created", "Welcome to Microsoft", or you see the Outlook inbox.

## Error Handling
| Error | Action |
|-------|--------|
| Email taken | Try different username (more random digits) |
| CAPTCHA fails | Retry solve-captcha up to 3x |
| Phone required, no phone | Report back to Director, stop |
| Page not responding | Take screenshot, wait 5s, retry |

## After Outlook Account Created
Report: "Outlook account created for <clientId>: <email>@outlook.com — credentials saved to clients.json. Ready to proceed with social media account creation."
