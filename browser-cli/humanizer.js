// humanizer.js — Upgraded human behavior middleware with accessibility tree support.
// Used by session-daemon.js for all browser interactions.
//
// Key upgrades over human-browser/src/:
//   • Accessibility tree snapshot → e1..eN ref system
//   • Click/fill by a11y ref (no CSS selectors required)
//   • Typing error rate: configurable 4–9% (default 6.5%)
//   • Realization delay: 600–1500ms (extended from 400–800ms)
//   • Tab sync: background tab idle breathing between primary actions

// ── Math utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function gaussian(mean, std) {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ── Accessibility Tree ─────────────────────────────────────────────────────────
// PRIMARY: CDP Accessibility domain (page.accessibility.snapshot).
// Runs in Chrome's accessibility service thread — completely separate from the JS
// main thread. Cannot block, handles shadow DOM automatically, completes in 200-800ms
// on any page including YouTube and LinkedIn.
//
// FALLBACK: minimal page.evaluate() with 5s budget and no shadow DOM traversal.
// Used only when the CDP a11y API returns empty (blank/loading page) or throws.

const A11Y_ACTIONABLE = new Set(['button','link','textbox','searchbox','checkbox','radio',
  'combobox','listbox','option','menuitem','tab','switch','slider']);
const A11Y_INFORMATIVE = new Set(['heading','image','img','listitem']);

// Walk the CDP a11y tree (returned by page.accessibility.snapshot) and collect refs.
function walkA11yTree(node, results, seen) {
  if (!node || results.length >= 300) return;
  const role = (node.role || '').toLowerCase();
  // CDP uses 'image'; our ref system uses 'img' to match Playwright getByRole
  const normalizedRole = role === 'image' ? 'img' : role;
  const name = (node.name || '').trim().slice(0, 120);

  if ((A11Y_ACTIONABLE.has(normalizedRole) || A11Y_INFORMATIVE.has(normalizedRole)) && name) {
    const key = normalizedRole + '::' + name.slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        role: normalizedRole,
        name,
        value: node.value !== undefined ? String(node.value) : '',
        // CDP checked can be boolean or "mixed"; normalise to boolean/undefined
        checked: typeof node.checked === 'boolean' ? node.checked
               : node.checked === 'mixed'          ? true
               : undefined,
        disabled: !!(node.disabled),
      });
    }
  }

  if (node.children) {
    for (const child of node.children) {
      walkA11yTree(child, results, seen);
      if (results.length >= 300) break;
    }
  }
}

// Fallback: JS-side evaluate — light DOM only, no getComputedStyle, 5s budget.
// Returns [] on any error so snapshot() never hard-fails.
async function getA11yTreeViaJSFallback(page) {
  // LinkedIn renders content inside hidden iframes/frames.
  // We query ALL frames and merge results, taking the richest one.
  const queryFn = () => {
    const TAG_ROLES = {
      button:'button', a:'link', select:'combobox', textarea:'textbox',
      h1:'heading',h2:'heading',h3:'heading',h4:'heading',h5:'heading',h6:'heading',
    };
    function getRole(el) {
      const r = el.getAttribute('role');
      if (r && r !== 'presentation' && r !== 'none') return r;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'search') return 'searchbox';
        if (['text','email','password','tel','url','number','date'].includes(t)) return 'textbox';
        if (['button','submit','reset'].includes(t)) return 'button';
        return '';
      }
      return TAG_ROLES[tag] || '';
    }
    function getName(el) {
      let v = el.getAttribute('aria-label'); if (v?.trim()) return v.trim();
      v = el.getAttribute('placeholder'); if (v?.trim()) return v.trim();
      v = el.getAttribute('title'); if (v?.trim()) return v.trim();
      v = el.getAttribute('alt'); if (v?.trim()) return v.trim();
      v = el.textContent?.trim(); if (v && v.length > 0 && v.length <= 120) return v;
      return '';
    }
    const SELECTOR = 'button,a,input,select,textarea,h1,h2,h3,h4,h5,h6'
      + ',[role="button"],[role="link"],[role="textbox"],[role="searchbox"]'
      + ',[role="checkbox"],[role="radio"],[role="combobox"],[role="menuitem"],[role="tab"]';
    const results = [], nameCount = new Map();
    const t0 = Date.now();
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (Date.now() - t0 > 8000 || results.length >= 500) break;
      const role = getRole(el); if (!role) continue;
      const name = getName(el); if (!name) continue;
      // Track how many times we've seen this role+name combo
      const baseKey = role + '::' + name.slice(0, 60);
      const idx = nameCount.get(baseKey) || 0;
      nameCount.set(baseKey, idx + 1);
      results.push({
        role, name,
        dupIndex: idx,
        value: el.value || '',
        checked: el.checked !== undefined ? el.checked : undefined,
        disabled: !!(el.disabled),
      });
    }
    return results;
  };

  try {
    // Query all frames in parallel and take the richest result
    const frames = page.frames();
    const frameResults = await Promise.race([
      Promise.all(
        frames.map(f => f.evaluate(queryFn).catch(() => []))
      ),
      new Promise(r => setTimeout(() => r([[]]), 15000)),
    ]);

    // Merge all frame results — NO deduplication, keep everything
    const merged = [], nameCount = new Map();
    // Sort frames by result count descending — richest frame first
    const sorted = [...frameResults].sort((a, b) => b.length - a.length);
    for (const frameElems of sorted) {
      for (const el of frameElems) {
        const baseKey = el.role + '::' + (el.name || '').slice(0, 60);
        const idx = nameCount.get(baseKey) || 0;
        nameCount.set(baseKey, idx + 1);
        el.dupIndex = idx;
        merged.push(el);
        if (merged.length >= 500) break;
      }
      if (merged.length >= 500) break;
    }

    return merged;
  } catch {
    return [];
  }
}

async function getA11yTree(page, { afterNavigation = false } = {}) {
  if (afterNavigation) {
    // After navigation: fixed 8-12s settle (no networkidle — LinkedIn never goes idle)
    await new Promise(r => setTimeout(r, 8000 + Math.random() * 4000));
  } else {
    // Normal snapshot: 2-3s
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
  }

  // Query the actual DOM directly across all frames
  return getA11yTreeViaJSFallback(page);
}

// Take accessibility tree snapshot of current page, return ref map + formatted list
export async function snapshot(page, { afterNavigation = false } = {}) {
  const nodes = await getA11yTree(page, { afterNavigation });
  const refs = {};
  let n = 1;
  for (const node of (nodes || [])) {
    const ref = `e${n++}`;
    refs[ref] = {
      ref,
      role: node.role,
      name: node.name,
      value: node.value || '',
      checked: node.checked,
      disabled: node.disabled,
      description: '',
    };
  }

  // Build human-readable list for agent
  const list = Object.values(refs).map(r => {
    const extra = r.value ? ` [value="${r.value}"]` : '';
    const checked = r.checked !== undefined ? ` [checked=${r.checked}]` : '';
    const disabled = r.disabled ? ' [disabled]' : '';
    return `ref=${r.ref}  ${r.role}  "${r.name}"${extra}${checked}${disabled}`;
  }).join('\n');

  // page.url() returns "" for pages opened before Playwright connected (CDP attach case)
  // Fall back to window.location.href which always reflects the real URL
  let url = page.url();
  if (!url || url === 'about:blank') {
    url = await page.evaluate(() => window.location.href).catch(() => url || '');
  }
  // page.title() can hang on detached frames even with timeout= — race it hard
  const title = await Promise.race([
    page.title({ timeout: 5000 }).catch(() => ''),
    new Promise(r => setTimeout(() => r(''), 5000)),
  ]);

  return { refs, list, url, title, refCount: Object.keys(refs).length };
}

// Find Playwright locator for a given ref from snapshot
export function locatorForRef(page, refObj) {
  const { role, name, dupIndex } = refObj;
  if (!role && !name) return null;
  const idx = dupIndex || 0;

  if (role && name) {
    return page.getByRole(role, { name, exact: false }).nth(idx);
  }
  if (name) {
    return page.getByText(name, { exact: false }).nth(idx);
  }
  return null;
}

// Search all frames for an element — used when main page locator fails
export async function locatorForRefAcrossFrames(page, refObj) {
  const { role, name, dupIndex } = refObj;
  if (!name) return null;
  const idx = dupIndex || 0;

  const frames = page.frames();
  for (const frame of frames) {
    try {
      // Strategy 1: getByRole
      if (role) {
        const shortName = name.slice(0, 40);
        const locator = frame.getByRole(role, { name: shortName, exact: false }).nth(idx);
        const count = await locator.count().catch(() => 0);
        if (count > 0) return locator;
      }

      // Strategy 2: getByPlaceholder (for textbox/combobox/searchbox)
      if (['textbox', 'combobox', 'searchbox'].includes(role)) {
        const locator = frame.getByPlaceholder(name.slice(0, 40), { exact: false }).nth(idx);
        const count = await locator.count().catch(() => 0);
        if (count > 0) return locator;
      }

      // Strategy 3: getByText
      {
        const shortText = name.slice(0, 30);
        const locator = frame.getByText(shortText, { exact: false }).nth(idx);
        const count = await locator.count().catch(() => 0);
        if (count > 0) return locator;
      }

      // Strategy 4: getByLabel
      {
        const locator = frame.getByLabel(name.slice(0, 40), { exact: false }).nth(idx);
        const count = await locator.count().catch(() => 0);
        if (count > 0) return locator;
      }
    } catch {}
  }

  return null;
}

// ── Mouse (Bézier curves) ──────────────────────────────────────────────────────

function deCasteljau(pts, t) {
  if (pts.length === 1) return [...pts[0]];
  const next = [];
  for (let i = 0; i < pts.length - 1; i++) {
    next.push([
      (1 - t) * pts[i][0] + t * pts[i + 1][0],
      (1 - t) * pts[i][1] + t * pts[i + 1][1],
    ]);
  }
  return deCasteljau(next, t);
}

function buildPath(x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (dist < 2) return [[x1, y1]];

  // Perpendicular unit vector for wobble
  const nx = -(y1 - y0) / dist;
  const ny = (x1 - x0) / dist;

  // Crazy human Bézier: 3–6 control points with wild perpendicular offsets
  // Each control point independently signed — mouse zigzags left-right across path
  const numCtrl = 3 + Math.floor(Math.random() * 4);
  const pts = [[x0, y0]];
  for (let i = 0; i < numCtrl; i++) {
    const t = (i + 1) / (numCtrl + 1);
    const bx = x0 + t * (x1 - x0);
    const by = y0 + t * (y1 - y0);
    // Each control point gets an independent random sign → zigzag effect
    const sign = Math.random() > 0.5 ? 1 : -1;
    const wobbleFactor = 0.25 + Math.random() * 0.55; // 25–80% of dist
    const wobble = sign * dist * wobbleFactor;
    pts.push([bx + nx * wobble, by + ny * wobble]);
  }
  pts.push([x1, y1]);

  // Steps based on straight-line dist (keeps total time proportional to real distance)
  const steps = Math.max(20, Math.floor(dist / 8));
  const path = [];
  for (let i = 0; i <= steps; i++) path.push(deCasteljau(pts, i / steps));

  // Overshoot and correct: 35% chance — mouse goes past target then backs up
  if (dist > 30 && Math.random() < 0.35) {
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const overshoot = 8 + Math.random() * 24;
    const ox = x1 + Math.cos(angle) * overshoot;
    const oy = y1 + Math.sin(angle) * overshoot;
    const corrSteps = 6 + Math.floor(Math.random() * 6);
    for (let i = 1; i <= corrSteps; i++) {
      path.push([
        ox + (x1 - ox) * (i / corrSteps),
        oy + (y1 - oy) * (i / corrSteps),
      ]);
    }
  }

  return path;
}

export async function moveTo(page, x1, y1, mouseState) {
  const x0 = mouseState.x ?? (page.viewportSize()?.width ?? 1366) / 2;
  const y0 = mouseState.y ?? (page.viewportSize()?.height ?? 768) / 2;
  const dist = Math.hypot(x1 - x0, y1 - y0);

  // 7% chance: crazy OCD-style mouse jitter before (and sometimes after) moving to target
  const doOcdJitter = dist > 50 && Math.random() < 0.07;
  const ocdJitterAfterToo = doOcdJitter && Math.random() < 0.3; // 30% chance of doing it again after reaching target

  if (doOcdJitter) {
    const jitterDegree = Math.random() * 360 * Math.PI / 180; // random angle
    const jitterCount = 4 + Math.floor(Math.random() * 8);    // 4-11 rapid movements
    const jitterRadius = 30 + Math.random() * 120;             // how far the jitter goes
    let jx = x0, jy = y0;

    for (let j = 0; j < jitterCount; j++) {
      // Alternate direction with random variation
      const angle = jitterDegree + (j % 2 === 0 ? 1 : -1) * (0.3 + Math.random() * 0.7);
      const jDist = jitterRadius * (0.3 + Math.random() * 0.7);
      jx = clamp(x0 + Math.cos(angle) * jDist * (Math.random() - 0.3), 10, 1400);
      jy = clamp(y0 + Math.sin(angle) * jDist * (Math.random() - 0.3), 10, 880);
      await page.mouse.move(jx, jy);
      await sleep(8 + Math.random() * 25); // very fast movements
    }
    // Brief pause after the jitter (realizing we need to focus)
    await sleep(100 + Math.random() * 300);
  }

  // 5% chance: imperfect circle/loop before reaching target
  if (dist > 80 && Math.random() < 0.05) {
    const loopRadius = 40 + Math.random() * 80;
    const loopSteps = 12 + Math.floor(Math.random() * 12);
    const loopCenterX = (x0 + x1) / 2 + (Math.random() - 0.5) * 60;
    const loopCenterY = (y0 + y1) / 2 + (Math.random() - 0.5) * 60;

    for (let i = 0; i < loopSteps; i++) {
      const angle = (i / loopSteps) * Math.PI * 2;
      // Imperfect circle — vary radius per step
      const r = loopRadius * (0.7 + Math.random() * 0.6);
      const lx = loopCenterX + Math.cos(angle) * r;
      const ly = loopCenterY + Math.sin(angle) * r;
      await page.mouse.move(clamp(lx, 5, 1420), clamp(ly, 5, 890));
      await sleep(15 + Math.random() * 30);
    }
    await sleep(50 + Math.random() * 200);
  }

  // Build the main Bézier path
  const path = buildPath(x0, y0, x1, y1);

  // Fitts' Law: T = a + b * log2(2D/W)
  // Larger distance or smaller target → slower movement
  // Research: human mouse speeds range 30-120 px/s depending on task precision
  const targetWidth = 20 + Math.random() * 30; // random estimated target width (20-50px)
  const fittsA = 150 + Math.random() * 150; // random intercept (150-300ms)
  const fittsB = 120 + Math.random() * 80;  // random slope (120-200ms per bit)
  const fittsTime = fittsA + fittsB * Math.log2(Math.max(1, 2 * dist / targetWidth));
  const speedVariation = 0.6 + Math.random() * 0.8; // 60%-140% speed variation per move
  const totalMs = fittsTime * speedVariation;
  const stepDelay = totalMs / path.length;

  // 25% chance: random mid-path freeze (user glanced elsewhere)
  const midPauseIdx = dist > 60 && Math.random() < 0.25
    ? Math.floor(path.length * (0.3 + Math.random() * 0.4))
    : -1;

  // 11% chance: speed change mid-path (started fast then slows, or started slow then speeds up)
  const speedChangeIdx = Math.random() < 0.11
    ? Math.floor(path.length * (0.3 + Math.random() * 0.4))
    : -1;
  // Random speed factor: 0.3-0.6 = decelerate (fast→slow), 1.4-2.0 = accelerate (slow→fast)
  const speedChangeFactor = Math.random() < 0.5
    ? 0.3 + Math.random() * 0.3   // decelerate
    : 1.4 + Math.random() * 0.6;  // accelerate

  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i];
    await page.mouse.move(x, y);

    let delay = stepDelay;
    if (i === midPauseIdx) {
      await sleep(200 + Math.random() * 800);
      continue;
    }
    if (speedChangeIdx > 0 && i >= speedChangeIdx) {
      delay *= speedChangeFactor;
    }
    await sleep(Math.max(1, delay + gaussian(0, delay * 0.3)));
  }

  // Micro-jitter at destination: hand tremor (40% chance, 2–7 tiny wiggles, variable intensity)
  if (dist > 15 && Math.random() < 0.4) {
    const jiggles = 2 + Math.floor(Math.random() * 6);
    const jiggleIntensity = 2 + Math.random() * 6;
    for (let j = 0; j < jiggles; j++) {
      await page.mouse.move(
        x1 + (Math.random() - 0.5) * jiggleIntensity,
        y1 + (Math.random() - 0.5) * jiggleIntensity
      );
      await sleep(15 + Math.random() * 50);
    }
    await page.mouse.move(x1, y1);
  }

  // OCD jitter AFTER reaching target (30% chance when OCD jitter was triggered before)
  if (ocdJitterAfterToo) {
    await sleep(80 + Math.random() * 200);
    const jitterDegree2 = Math.random() * 360 * Math.PI / 180;
    const jitterCount2 = 3 + Math.floor(Math.random() * 6);
    const jitterRadius2 = 20 + Math.random() * 80;

    for (let j = 0; j < jitterCount2; j++) {
      const angle = jitterDegree2 + (j % 2 === 0 ? 1 : -1) * (0.3 + Math.random() * 0.7);
      const jDist = jitterRadius2 * (0.3 + Math.random() * 0.7);
      const jx = clamp(x1 + Math.cos(angle) * jDist * (Math.random() - 0.3), 10, 1400);
      const jy = clamp(y1 + Math.sin(angle) * jDist * (Math.random() - 0.3), 10, 880);
      await page.mouse.move(jx, jy);
      await sleep(8 + Math.random() * 20);
    }
    await sleep(50 + Math.random() * 150);

    // Return to target — but not exactly center, slightly off
    const finalOffsetX = (Math.random() - 0.5) * 10;
    const finalOffsetY = (Math.random() - 0.5) * 10;
    await page.mouse.move(x1 + finalOffsetX, y1 + finalOffsetY);
  }

  mouseState.x = x1;
  mouseState.y = y1;
}

// Click an element via bounding box — used when we have a locator
export async function humanClick(page, locator, mouseState) {
  let box;

  // Stage 1: standard visibility check
  try {
    await locator.waitFor({ state: 'visible', timeout: 3600000 });
    box = await locator.boundingBox();
  } catch (_e1) {
    // Stage 2: scroll the element into view, then retry visibility
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 3600000 });
      await locator.waitFor({ state: 'visible', timeout: 3600000 });
      box = await locator.boundingBox();
    } catch (_e2) {
      // Stage 3: element is in DOM (attached) but not strictly "visible" by Playwright rules
      // (e.g. covered by overlay, zero-opacity, in shadow DOM). Get bbox directly via JS.
      try {
        await locator.waitFor({ state: 'attached', timeout: 3600000 });
        box = await locator.evaluate(el => {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return null;
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
      } catch (e3) {
        throw new Error(`Element not reachable: ${e3.message}`);
      }
    }
  }

  if (!box) throw new Error('Element has no bounding box (zero-size or detached)');

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = 5 + Math.random() * 10;
  const angle = Math.random() * Math.PI * 2;
  const tx = cx + radius * Math.cos(angle);
  const ty = cy + radius * Math.sin(angle);

  await moveTo(page, tx, ty, mouseState);
  await sleep(200 + Math.random() * 400);   // hover hesitation

  // 40% chance: paranoid pre-click wiggle — user double-checks before clicking
  if (Math.random() < 0.40) {
    const wiggles = 2 + Math.floor(Math.random() * 3);
    for (let w = 0; w < wiggles; w++) {
      await page.mouse.move(tx + (Math.random() - 0.5) * 14, ty + (Math.random() - 0.5) * 8);
      await sleep(55 + Math.random() * 130);
    }
    await page.mouse.move(tx, ty);
    await sleep(60 + Math.random() * 120);
  }

  await page.mouse.click(tx, ty);
  mouseState.x = tx;
  mouseState.y = ty;
  return { x: Math.round(tx), y: Math.round(ty) };
}

// ── Keyboard (Gaussian timing + error injection) ───────────────────────────────

const FAST_PAIRS = new Set([
  'th','he','in','er','an','re','on','en','at','nd',
  'st','es','ed','to','it','al','is','ar','se','ou',
  'ha','nt','ng','ti','ea','hi','as','te','et','of',
]);

const ADJACENT_KEYS = {
  a:'sqwz', b:'vghn', c:'xdfv', d:'esxcrf', e:'wrsdf', f:'edcgr', g:'rfvhyt',
  h:'tgybj', i:'ujklo', j:'huikm', k:'jilom', l:'kop;', m:'njk,',
  n:'bhjm', o:'iklp', p:'ol;[', q:'wa', r:'edft', s:'awedxz',
  t:'rfgy', u:'yhji', v:'cfgb', w:'qase', x:'zsdc', y:'tghu', z:'asx',
};

function adjacentMistype(char) {
  const adj = ADJACENT_KEYS[char.toLowerCase()];
  if (!adj) return char;
  return adj[Math.floor(Math.random() * adj.length)];
}

function keyDelay(prev, curr) {
  const pair = (prev + curr).toLowerCase();
  let mean = 115, std = 28;
  if (FAST_PAIRS.has(pair)) { mean = 65; std = 18; }
  if (prev === ' ') { mean += 25; std += 10; }
  if (/[.,!?;:\-]/.test(curr)) { mean += 60; std += 20; }
  if (/[.,!?;:\-]/.test(prev)) { mean += 40; std += 15; }
  if (curr !== curr.toLowerCase()) { mean += 30; }
  return Math.max(35, gaussian(mean, std));
}

// Type with random error rate per session (4.5%–9.5%), realization delay 600–1500ms
export async function humanType(page, text, { errorRate } = {}) {
  // Pick a fresh random error rate for this typing session
  if (errorRate === undefined) errorRate = 0.045 + Math.random() * 0.05; // 4.5%–9.5%
  let wordCount = 0;
  let burstTarget = 3 + Math.floor(Math.random() * 3);
  let prevChar = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === ' ') {
      wordCount++;
      if (wordCount >= burstTarget) {
        await sleep(180 + Math.random() * 320);
        wordCount = 0;
        burstTarget = 3 + Math.floor(Math.random() * 3);
      }
    }

    const eligible = char !== ' ' && char !== '\n' && char !== '\t' && i > 0;
    if (eligible && Math.random() < errorRate) {
      const wrong = adjacentMistype(char);
      await page.keyboard.type(wrong);
      await sleep(keyDelay(prevChar, wrong));

      // Realization delay: 600–1500ms (extended for realism)
      await sleep(600 + Math.random() * 900);
      await page.keyboard.press('Backspace');
      await sleep(50 + Math.random() * 40);
      await page.keyboard.type(char);
      await sleep(35 + Math.random() * 35);
    } else {
      await page.keyboard.type(char);
      await sleep(keyDelay(prevChar, char));
    }
    prevChar = char;
  }
}

// ── Scroll ─────────────────────────────────────────────────────────────────────

export async function humanScroll(page, totalPixels, direction = 'down') {
  const sign = direction === 'down' ? 1 : -1;
  const total = Math.abs(totalPixels);

  // Clean, smooth scroll — 5-8 sub-steps, decelerating
  const steps = 5 + Math.floor(Math.random() * 4);
  const totalWeight = (steps * (steps + 1)) / 2;

  for (let s = steps; s > 0; s--) {
    await page.mouse.wheel(0, sign * total * (s / totalWeight));
    await sleep(10 + Math.random() * 15);
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────

export async function humanNavigate(page, url) {
  // 25% exploratory detour
  if (Math.random() < 0.25) {
    try {
      const u = new URL(url);
      const detours = [u.origin, u.origin + '/about', u.origin + '/blog'];
      const detour = detours[Math.floor(Math.random() * detours.length)];
      if (detour !== url) {
        await page.goto(detour, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(3000 + Math.random() * 7000);
      }
    } catch { /* ignore */ }
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 600000 });
  // Wait for full load so React/SPA initial render completes before returning
  await page.waitForLoadState('load', { timeout: 120000 }).catch(() => {});
  await sleep(1500 + Math.random() * 1500);   // slightly longer settle time
}

// ── Tab synchronization ────────────────────────────────────────────────────────

// Max background tabs to keep open per session (1 primary + 5 background = 6 total)
export const MAX_BACKGROUND_TABS = 5;
export const MAX_TABS_PER_SESSION = 6;

// Open a background tab and briefly "read" it — simulates a real user
// Caller should check context.pages().length < MAX_TABS_PER_SESSION before calling
export async function openBackgroundTab(context, url) {
  const openPages = context.pages().length;
  if (openPages >= MAX_TABS_PER_SESSION) {
    // Too many tabs — skip opening background tab silently
    return null;
  }
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1000 + Math.random() * 2000);
    // Scroll a bit — shows the page is "alive"
    await humanScroll(page, 200 + Math.random() * 300, 'down');
  } catch { /* non-fatal if background tab fails to load */ }
  return page;
}

// Briefly switch focus to a background tab then return — humanizes focus pattern
export async function breatheOnBackgroundTab(bgPage, primaryPage) {
  if (!bgPage || bgPage.isClosed()) return;
  try {
    await bgPage.bringToFront();
    await sleep(1500 + Math.random() * 4000);
    // Maybe scroll a bit
    if (Math.random() > 0.5) {
      await humanScroll(bgPage, 100 + Math.random() * 300, Math.random() > 0.3 ? 'down' : 'up');
    }
    await sleep(500 + Math.random() * 1500);
    await primaryPage.bringToFront();
    await sleep(300 + Math.random() * 500);
  } catch { /* non-fatal */ }
}

// ── Fill a field (click + clear + type) ───────────────────────────────────────

export async function humanFill(page, locator, text, mouseState, { errorRate = 0.065 } = {}) {
  await humanClick(page, locator, mouseState);
  await sleep(300 + Math.random() * 200);
  // Select all and delete existing content
  await page.keyboard.press('Control+a');
  await sleep(100 + Math.random() * 100);
  await page.keyboard.press('Delete');
  await sleep(200 + Math.random() * 200);
  await humanType(page, text, { errorRate });
}
