---
name: sm-twitter
description: "Set up and manage Twitter/X profiles for clients. Use for bio, display name, location, and website setup on Twitter/X."
triggers:
  - set up twitter
  - twitter profile
  - configure twitter
  - set up x profile
  - twitter bio
---

# Twitter/X Profile Setup Skill

## Prerequisites
- `mlProfileId` from `pa-lookup.js <clientId> twitter`
- `credentials.username` and `credentials.password`
- `profileContent.bio` (160 chars max, generated with platform:twitter)

---

## Login

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://twitter.com/i/flow/login"},
    {"action": "wait", "ms": 3000},
    {"action": "click", "selector": "input[autocomplete=username]"},
    {"action": "type", "text": "<username>"},
    {"action": "press", "key": "Enter"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "input[name=password]"},
    {"action": "type", "text": "<password>"},
    {"action": "press", "key": "Enter"},
    {"action": "wait", "ms": 4000},
    {"action": "getPageText"}
  ]
}' --timeout 90
```

---

## Edit Profile

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://twitter.com/settings/profile"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "input[name=displayName]"},
    {"action": "type", "text": "<display-name>"},
    {"action": "click", "selector": "textarea[name=description]"},
    {"action": "type", "text": "<bio-160-chars>"},
    {"action": "click", "selector": "input[name=location]"},
    {"action": "type", "text": "<city-or-region>"},
    {"action": "click", "selector": "input[name=url]"},
    {"action": "type", "text": "<website-url>"},
    {"action": "click", "selector": "div[data-testid=settingsSaveButton]"},
    {"action": "wait", "ms": 2000},
    {"action": "screenshot", "path": "/tmp/twitter-profile-done.png"},
    {"action": "getPageText"}
  ]
}' --timeout 120
```

## Completion Report Format

```
Twitter/X profile setup complete for [Client Name]:
- Display name: "[name]"
- Bio: "[bio text]" ([char count] chars)
- Location: [location or "not set"]
- Website: [url or "not set"]
- MultiLogin X profile used: [profileId]
```
