---
name: img-gen-4
description: "Generate images using Google Gemini (Imagen 3) via browser automation. Use this skill to navigate Gemini, enter a crafted image prompt, wait for generation, and download the result."
triggers:
  - generate image
  - create image
  - gemini image
  - imagen
---

# Gemini Image Generation Skill

## Prerequisites
- Your `mlProfileId` (from google-accounts.json — see SOUL.md Step 2)
- Your crafted image prompt (refined using SOUL.md Prompting Guide — NOT the raw request)
- `outputDir` from the claimed request JSON

---

## Phase 1 — Open Gemini and Verify Session

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "img-gen-4",
  "platform": "gemini",
  "steps": [
    {"action": "goto", "url": "https://gemini.google.com/app"},
    {"action": "wait", "ms": 4000},
    {"action": "screenshot", "path": "/tmp/img-gen-4-gemini-open.png"},
    {"action": "getPageText"}
  ]
}' --timeout 60
```

**Verify:** Page text should contain "Gemini" or "Google". If it contains "Sign in" or "Log in" — the session is expired. Mark request as failed with session-expired message and stop.

---

## Phase 2 — Enter the Image Prompt

**Primary selector** for Gemini input: `div.ql-editor[contenteditable="true"]`

**Fallback selectors** (try in order if primary fails):
1. `rich-textarea .ql-editor`
2. `div[contenteditable="true"][role="textbox"]`
3. `div[contenteditable="true"]`
4. `textarea`

```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "img-gen-4",
  "platform": "gemini",
  "steps": [
    {"action": "click", "selector": "div.ql-editor[contenteditable=\"true\"]"},
    {"action": "wait", "ms": 600},
    {"action": "type", "text": "Generate an image: <YOUR_CRAFTED_PROMPT>"},
    {"action": "wait", "ms": 500},
    {"action": "press", "key": "Enter"},
    {"action": "wait", "ms": 90000},
    {"action": "screenshot", "path": "/tmp/img-gen-4-after-generate.png"},
    {"action": "getPageImages", "selector": "img"},
    {"action": "getPageText"}
  ]
}' --timeout 180
```

**Wait 90 seconds** after pressing Enter — Imagen 3 typically takes 20–80 seconds.

---

## Phase 3 — Find the Generated Image

After generation, look at the `getPageImages` result. The generated image will be:
- **Large dimensions** (width and height both > 256px, usually 512px or larger)
- **Last large image** in the list (most recently generated)
- **URL patterns**: `lh3.googleusercontent.com`, `*.bard.google.com`, blob URLs, or data URLs

**Filter logic** (describe to yourself from getPageImages output):
- Ignore small images (icons, logos — typically < 100px)
- Pick the last image with width > 256 and height > 256
- Note its `src` or `currentSrc` URL

---

## Phase 4 — Download the Image

### Option A: Download by selector (if image has identifiable selector)
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "img-gen-4",
  "platform": "gemini",
  "steps": [
    {"action": "downloadImage",
     "selector": "<CSS_SELECTOR_OF_GENERATED_IMAGE>",
     "path": "<outputDir>/image-1.png"}
  ]
}' --timeout 60
```

### Option B: Download by URL (preferred when you have the exact URL from getPageImages)
```bash
node /data/director/dispatch.js '{
  "mlProfileId": "<PROFILE_ID>",
  "clientId": "img-gen-4",
  "platform": "gemini",
  "steps": [
    {"action": "downloadImage",
     "url": "<IMAGE_URL_FROM_GETPAGEIMAGES>",
     "path": "<outputDir>/image-1.png"}
  ]
}' --timeout 60
```

---

## Phase 5 — Verify Download

```bash
ls -la <outputDir>/image-1.png
```

A valid image file is at least **50 KB**. If smaller or missing → download failed → retry from Phase 2 with a slightly rephrased prompt.

---

## Phase 6 — For Multiple Images (count > 1)

If the request has `count > 1`, repeat Phase 2–5 for each image:
- Second image: type a new prompt variation or "Generate another image like the previous one but with slight variation"
- Save as `image-2.png`, `image-3.png`, etc.

---

## Retry Logic

- **Attempt 1**: Try primary selectors and standard flow
- **Attempt 2**: Take debug screenshot, adapt selectors from what you see, try again
- **Attempt 3**: Try a simplified version of the prompt (shorter, more direct)
- **After 3 failures**: Call img-complete.js with failure and move to next request

Between retry attempts, wait 30 seconds: `{"action": "wait", "ms": 30000}`

---

## Completion Report Format

After all images downloaded successfully:
```
Image generation complete:
- Request ID: [requestId]
- Agent: img-gen-4
- Images generated: [N]
- Output directory: [outputDir]
- Files: image-1.png [, image-2.png, ...]
- Gemini prompt used: "[your refined prompt]"
- Context: [original request context]
```

---

## Quick Debug Commands

```bash
# Check if director is running
cat /tmp/director.pid && kill -0 $(cat /tmp/director.pid) && echo "RUNNING" || echo "DOWN"

# Restart if needed
bash /data/setup-human-browser.sh

# View last screenshot
ls -la /tmp/img-gen-4-*.png

# Check queue
ls /data/image-requests/pending/ /data/image-requests/running/
```
