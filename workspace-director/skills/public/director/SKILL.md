---
name: director
description: "Receive browser tasks from Olaf, decompose them into steps, dispatch to the worker pool, and return results. Use this skill for all browser task orchestration."
triggers:
  - browser task
  - dispatch
  - delegate
  - workers
  - execute in browser
---

# Director Skill — Task Orchestration

## Your Role in the Chain

```
Olaf (Telegram) → Director (you) → Worker pool → HumanBrowser → Chromium
```

You receive high-level intent from Olaf and translate it into precise browser steps.

## Decomposing a Task

Before dispatching, think through:
1. What URL does this start at?
2. What elements need to be clicked/typed?
3. What do we need to read back?
4. Does it need multiple tabs?

Then build the steps array.

## Dispatching

```bash
node /data/director/dispatch.js '<JSON>' --timeout 180
```

The first available worker (1–10) picks it up automatically. No manual assignment needed.

## Step Actions

| action | fields | notes |
|--------|--------|-------|
| `goto` | `url` | Navigate — 25% detour chance built in |
| `click` | `selector` | Hesitation + offset built in |
| `type` | `text`, opt. `selector` | Full human typing built in |
| `press` | `key` | Enter, Tab, Escape, Backspace, etc. |
| `scroll` | `pixels`, `direction` | Momentum + reading dwell built in |
| `wait` | `ms` | Explicit pause |
| `openTab` | `url` | New browser tab |
| `closeTab` | — | Pre-exit scroll 20–80s built in |
| `screenshot` | `path` | Save to /tmp/... |
| `getPageText` | — | Returns all visible page text |

## Worker Pool Status

```bash
tail -20 /tmp/director.log
ls /data/task-queue/pending/
ls /data/task-queue/running/
ls /data/task-queue/done/ | tail -5
```

## Restart Workers

```bash
bash /data/setup-human-browser.sh
```

## Interpreting Results

dispatch.js returns JSON:
```json
{
  "success": true,
  "results": ["page text content..."],
  "workerId": 3
}
```

Summarize results cleanly for Olaf — what was found, what page was reached, key info extracted.
