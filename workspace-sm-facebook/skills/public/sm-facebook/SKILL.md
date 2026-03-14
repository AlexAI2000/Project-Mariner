---
name: sm-facebook
description: "Set up and manage Facebook profiles and pages for clients. Use for bio/intro, work history, and about section setup on Facebook."
triggers:
  - set up facebook
  - facebook profile
  - configure facebook
  - facebook bio
  - facebook page
---

# Facebook Profile Setup Skill

## Prerequisites
- `mlProfileId` from `pa-lookup.js <clientId> facebook`
- `credentials.email` and `credentials.password`
- `profileContent.bio` (255 chars max for intro, generated with platform:facebook)

---

## Login

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.facebook.com/login"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "input#email"},
    {"action": "type", "text": "<email>"},
    {"action": "click", "selector": "input#pass"},
    {"action": "type", "text": "<password>"},
    {"action": "click", "selector": "button[name=login]"},
    {"action": "wait", "ms": 4000},
    {"action": "getPageText"}
  ]
}' --timeout 90
```

---

## Edit Intro / Bio

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.facebook.com/me"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "div[data-pagelet*=ProfileTilesFeed] a[href*=about]"},
    {"action": "wait", "ms": 2000},
    {"action": "screenshot", "path": "/tmp/facebook-about.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

**Note:** Facebook's UI is highly dynamic. Always take a screenshot first to identify the correct elements before editing. Use `getPageText` to understand the current state.

Navigate to the About tab and use the Edit buttons for:
- Overview / Intro (255 char bio)
- Work and education
- Places lived

Take a screenshot at each step and adapt selectors based on what you see.

---

## Work History

Navigate to About → Work and education → Add a workplace:
```bash
# Steps: click "Add a workplace", fill in Company, Position, City, Description, Time period, Save
```
Add each work history entry from `profileContent.workHistory`.

---

## Completion Report Format

```
Facebook profile setup complete for [Client Name]:
- Intro/bio: "[bio text]" ([char count] chars)
- Work entries added: [N]
- MultiLogin X profile used: [profileId]
Note: Facebook UI is dynamic — verify profile visually at: https://www.facebook.com/me
```
