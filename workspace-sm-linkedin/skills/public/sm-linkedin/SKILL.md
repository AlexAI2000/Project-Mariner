---
name: sm-linkedin
description: "Set up and manage LinkedIn profiles for clients. Use this skill for profile creation, headline writing, bio setup, work history, skills, and featured section configuration on LinkedIn."
triggers:
  - set up linkedin
  - linkedin profile
  - configure linkedin
  - linkedin headline
  - linkedin bio
  - linkedin work history
  - linkedin skills
---

# LinkedIn Profile Setup Skill

## Prerequisites (Always First)
1. `mlProfileId` — from `node /data/executor/pa-lookup.js <clientId> linkedin`
2. `credentials.email` and `credentials.password` — from pa-lookup output
3. `profileContent` — generated or cached (see SOUL.md workflow)

---

## Login (if session expired)

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/login"},
    {"action": "click", "selector": "#username"},
    {"action": "type", "text": "<email>"},
    {"action": "click", "selector": "#password"},
    {"action": "type", "text": "<password>"},
    {"action": "click", "selector": "button[type=submit]"},
    {"action": "wait", "ms": 3000},
    {"action": "getPageText"}
  ]
}' --timeout 60
```
Verify result contains "Feed" or profile name to confirm logged in.

---

## Section 1: Headline & Name (Edit Intro)

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/in/me/"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "button[aria-label*='Edit intro']"},
    {"action": "wait", "ms": 1500},
    {"action": "click", "selector": "input[name='headline']"},
    {"action": "screenshot", "path": "/tmp/linkedin-headline-before.png"},
    {"action": "type", "text": "<headline-from-profileContent>"},
    {"action": "click", "selector": "button[aria-label*='Save']"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 120
```

---

## Section 2: About / Bio

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/in/me/"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "section#about button[aria-label*='Edit']"},
    {"action": "wait", "ms": 1500},
    {"action": "click", "selector": "textarea[name='summary']"},
    {"action": "type", "text": "<bio-from-profileContent>"},
    {"action": "click", "selector": "button[aria-label*='Save']"},
    {"action": "wait", "ms": 2000},
    {"action": "getPageText"}
  ]
}' --timeout 120
```

**Note:** If the `section#about` selector doesn't exist (no About section yet), try clicking the "Add profile section" button and adding "About" first.

---

## Section 3: Work History (Add Experience)

Add each work history entry separately. For each entry:

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/in/me/"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "section#experience button[aria-label*='Add']"},
    {"action": "wait", "ms": 1500},
    {"action": "click", "selector": "input[name='title']"},
    {"action": "type", "text": "<role>"},
    {"action": "click", "selector": "input[name='companyName']"},
    {"action": "type", "text": "<company>"},
    {"action": "click", "selector": "textarea[name='description']"},
    {"action": "type", "text": "<description>"},
    {"action": "click", "selector": "button[aria-label*='Save']"},
    {"action": "wait", "ms": 2000}
  ]
}' --timeout 180
```

Repeat for each role in `profileContent.workHistory`. Start with most recent.

---

## Section 4: Skills

LinkedIn skills must be added one at a time via the skills section:

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/in/me/details/skills/"},
    {"action": "wait", "ms": 2000},
    {"action": "click", "selector": "button[aria-label*='Add skill']"},
    {"action": "wait", "ms": 1000},
    {"action": "click", "selector": "input[role='combobox']"},
    {"action": "type", "text": "<skill-name>"},
    {"action": "wait", "ms": 1000},
    {"action": "press", "key": "Enter"},
    {"action": "click", "selector": "button[aria-label*='Save']"},
    {"action": "wait", "ms": 1500}
  ]
}' --timeout 60
```

Add up to 10 skills per dispatch call (batch them in steps) to stay within the 10-min limit.

---

## Section 5: Featured Section

LinkedIn Featured section is managed at `https://www.linkedin.com/in/me/`:

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<uuid>",
  "clientId": "<clientId>",
  "steps": [
    {"action": "goto", "url": "https://www.linkedin.com/in/me/"},
    {"action": "wait", "ms": 2000},
    {"action": "screenshot", "path": "/tmp/linkedin-featured-section.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

Take a screenshot and page text first — use that to identify the correct Featured section add buttons before proceeding. LinkedIn's Featured section UI varies by account state.

---

## Troubleshooting

**Selector not found:** LinkedIn updates its UI regularly. If a selector fails:
1. Take a screenshot: `{"action": "screenshot", "path": "/tmp/linkedin-debug.png"}`
2. Get page text: `{"action": "getPageText"}`
3. Adapt the selector based on what you see

**Session expired mid-task:** MultiLogin X keeps the session alive, but if LinkedIn forces re-auth, use the login steps at the top of this skill, then continue from where you left off.

**Rate limiting:** Add `{"action": "wait", "ms": 3000}` between heavy sections. LinkedIn is sensitive to rapid sequential edits.

---

## Completion Report Format

After all sections are done, report:
```
LinkedIn profile setup complete for [Client Name]:
- Headline: "[generated headline]" (generated / cached)
- Bio: [character count] characters (generated / cached)
- Work history: [N] entries added
- Skills: [N] skills added
- Featured: [N] items configured
- MultiLogin X profile used: [profileId]
```
