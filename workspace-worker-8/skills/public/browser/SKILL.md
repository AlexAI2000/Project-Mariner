---
name: browser
description: "Execute human-like browser automation tasks. Use this for ANY browser interaction — navigating, clicking, typing, scrolling, form filling, reading pages. Always dispatches through the HumanBrowser system."
triggers:
  - go to
  - navigate
  - browse
  - open
  - click
  - type
  - search
  - scroll
  - fill
  - submit
  - read page
  - screenshot
---

# Browser Skill — HumanBrowser Execution

## The One Rule

**Every browser action goes through dispatch.js. No exceptions.**

```bash
node /data/director/dispatch.js '<JSON>' --timeout 180
```

## Step Reference

```json
{"steps": [
  {"action": "goto",       "url": "https://example.com"},
  {"action": "click",      "selector": "#some-button"},
  {"action": "type",       "text": "hello world", "selector": "input#field"},
  {"action": "press",      "key": "Enter"},
  {"action": "scroll",     "pixels": 500, "direction": "down"},
  {"action": "scroll",     "pixels": 200, "direction": "up"},
  {"action": "wait",       "ms": 2000},
  {"action": "openTab",    "url": "https://other.com"},
  {"action": "closeTab"},
  {"action": "screenshot", "path": "/tmp/shot.png"},
  {"action": "getPageText"}
]}
```

## Human Behavior — Automatic, Every Time

The library handles all of this automatically on every dispatched action:

| Behavior | Implementation |
|----------|---------------|
| Mouse movement | Bézier curves, never straight. Gaussian speed mean=65px/s, range 40–85px/s |
| Click hesitation | 200–500ms pause before every click |
| Click accuracy | 5–15px random offset from element center |
| Typing speed | Variable: fast digraph pairs ~65ms, complex transitions ~115ms |
| Typing errors | 7% error rate → adjacent key mistype → 400–800ms realization → backspace → retype |
| Typing bursts | 3–5 word bursts → 180–500ms micro-pause |
| Scroll momentum | Decelerating bursts, 600–3500ms reading dwell |
| Navigation | 25% exploratory detour before target URL |
| Tab close | 20–80s idle pre-exit scroll |

You do not configure any of this. It happens automatically.

## Selector Tips

- Prefer specific IDs: `#search-input`, `#submit-btn`
- Use name attrs for forms: `input[name="email"]`, `textarea[name="q"]`
- Use type for buttons: `button[type="submit"]`
- Text content: `button:has-text("Sign in")` (Playwright syntax)
- Fallback to class: `.search-box`, `.cta-button`

## Common Patterns

### Google Search
```json
{"steps":[
  {"action":"goto","url":"https://www.google.com"},
  {"action":"click","selector":"textarea[name=q]"},
  {"action":"type","text":"search query"},
  {"action":"press","key":"Enter"},
  {"action":"wait","ms":1500},
  {"action":"scroll","pixels":500,"direction":"down"},
  {"action":"getPageText"}
]}
```

### Login Form
```json
{"steps":[
  {"action":"goto","url":"https://site.com/login"},
  {"action":"click","selector":"input[name=email]"},
  {"action":"type","text":"user@email.com"},
  {"action":"click","selector":"input[name=password]"},
  {"action":"type","text":"password123"},
  {"action":"click","selector":"button[type=submit]"},
  {"action":"wait","ms":2000},
  {"action":"getPageText"}
]}
```

### Read & Scroll Page
```json
{"steps":[
  {"action":"goto","url":"https://site.com/article"},
  {"action":"scroll","pixels":300,"direction":"down"},
  {"action":"scroll","pixels":300,"direction":"down"},
  {"action":"scroll","pixels":300,"direction":"down"},
  {"action":"getPageText"}
]}
```

### Multi-Tab Research
```json
{"steps":[
  {"action":"goto","url":"https://site1.com"},
  {"action":"getPageText"},
  {"action":"openTab","url":"https://site2.com"},
  {"action":"getPageText"},
  {"action":"closeTab"}
]}
```

## Checking System Health

```bash
# Director running?
cat /tmp/director.pid && kill -0 $(cat /tmp/director.pid) 2>/dev/null && echo "running" || echo "DOWN"

# Recent activity
tail -10 /tmp/director.log

# Restart if needed
bash /data/setup-human-browser.sh
```
