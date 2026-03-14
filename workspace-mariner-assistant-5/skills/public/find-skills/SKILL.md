---
name: find-skills
description: "Helps agents discover and install new skills from ClawHub (clawhub.ai ONLY). Use when: you encounter a wall you cannot get past, you need a capability you don't currently have, or you want to extend yourself with a new skill. SECURITY: Skills may ONLY be installed from clawhub.ai. GitHub, npm, and any other sources are ABSOLUTELY PROHIBITED."
---

# Find Skills — Mariner Secure Edition

This skill helps you discover and install skills that extend your capabilities.

## SECURITY POLICY — READ THIS FIRST

You operate under an **absolute security policy** for skill installation:

| Requirement | Rule |
|---|---|
| **Source** | Skills must come from `clawhub.ai` ONLY. GitHub, npm, skills.sh, and ANY other source are PROHIBITED. |
| **VirusTotal** | Must be `status=clean` AND `verdict=benign`. Any other result = BLOCKED. |
| **OpenClaw LLM Confidence** | Must be `confidence=high` AND `verdict=benign`. Medium, low, or suspicious = BLOCKED. |
| **Static scan** | Must be `status=clean` AND `findings=[]` (zero findings). |
| **Malware flag** | If ClawHub shows `isMalwareBlocked`, `isSuspicious`, or `isPendingScan` → BLOCKED. |

**If ANY security check fails — do not install. No exceptions. No overrides.**

The security scanner is not a suggestion. It is the final word.

---

## When to Use This Skill

Use this skill when you:

- Hit a wall and cannot figure out how to proceed
- Encounter a task that requires a capability you don't currently have
- Get a repeated error you cannot resolve with existing tools
- Want to extend yourself with specialized knowledge or workflow skills
- Are corrected or realize you need better tooling for a domain

---

## How to Install a Skill

### Step 1 — Search ClawHub

Think of the capability you need. Describe it in 2-3 keywords. Browse or search:

**URL:** `https://clawhub.ai` — search for your keyword in the search bar

Common skill categories:
- `browser-automation`, `playwright`, `linkedin`, `social-media`
- `error-recovery`, `retry-logic`, `session-management`
- `data-extraction`, `parsing`, `scraping`
- `self-improvement`, `logging`, `learning`

### Step 2 — Get the skill slug

The slug is the last part of the URL: `https://clawhub.ai/<owner>/<slug>`

Example: `https://clawhub.ai/pskoett/self-improving-agent` → slug is `self-improving-agent`

### Step 3 — Run the secure installer

**ALWAYS use the secure installer. Never download directly.**

```bash
node /data/mariner/secure-skill-install.js <slug> <your-workspace-dir>
```

Example:
```bash
node /data/mariner/secure-skill-install.js self-improving-agent /data/.openclaw/workspace-sm-linkedin-1
```

The installer will:
1. Fetch security scan data from ClawHub's API
2. Verify all 4 security gates (VirusTotal + LLM + Static + Moderation)
3. Download only if ALL gates pass
4. Verify SHA256 integrity of the download
5. Extract safely (with path traversal protection) into your workspace

### Step 4 — If security check fails

If the installer outputs `[SECURITY BLOCK]` — **stop**. Do not try to bypass it. Do not try an alternative download source.

Options when blocked:
1. Try a different skill from ClawHub that achieves the same goal
2. Build the capability yourself using existing tools
3. Log it to `.learnings/FEATURE_REQUESTS.md` for future consideration

---

## What NOT to Do

```
❌ NEVER: npx skills add <anything>
❌ NEVER: curl https://raw.githubusercontent.com/...
❌ NEVER: git clone https://github.com/...
❌ NEVER: npm install -g ...
❌ NEVER: wget/curl any skill from any URL except clawhub.ai
❌ NEVER: Install a skill that failed ANY security check
❌ NEVER: Override, bypass, or ignore the security installer
```

---

## Logging a Capability Gap

If you can't find a suitable skill or the available ones fail security:

```bash
# Log it to your feature requests
cat >> /data/.openclaw/workspace-<your-name>/.learnings/FEATURE_REQUESTS.md << 'EOF'

## [FEAT-<YYYYMMDD>-<XXX>] <capability_name>

**Logged**: <ISO timestamp>
**Priority**: medium
**Status**: pending
**Area**: browser | infra | social-media | config

### Requested Capability
<What you needed to be able to do>

### Context
<Why you needed it, what wall you hit>

### Complexity Estimate
simple | medium | complex

### Suggested Implementation
<How this could potentially be built>

### Metadata
- Frequency: first_time | recurring

---
EOF
```

---

*Mariner Secure Skill Finder — clawhub.ai ONLY — Zero Trust, Maximum Confidence*
