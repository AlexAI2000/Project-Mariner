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
  return Promise.race([
    page.evaluate(() => {
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
      const results = [], seen = new Set();
      const t0 = Date.now();
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (Date.now() - t0 > 8000 || results.length >= 200) break;
        const role = getRole(el); if (!role) continue;
        const name = getName(el); if (!name) continue;
        const key = role + '::' + name.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        results.push({
          role, name,
          value: el.value || '',
          checked: el.checked !== undefined ? el.checked : undefined,
          disabled: !!(el.disabled),
        });
      }
      return results;
    }),
    new Promise(r => setTimeout(() => r([]), 9000)), // resolve empty on timeout, never reject
  ]).catch(() => []);
}

async function getA11yTree(page) {
  // Wait for DOM to be ready (max 3s)
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  // Wait for full load — catches SPA pages that need JS hydration before a11y tree populates
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});

  // CDP accessibility snapshot — 20s ceiling, typically 200-800ms
  try {
    const tree = await Promise.race([
      page.accessibility.snapshot({ interestingOnly: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CDP a11y timeout 20s')), 20000)),
    ]);

    if (tree) {
      const results = [], seen = new Set();
      walkA11yTree(tree, results, seen);
      if (results.length >= 3) return results; // success
    }
    // CDP returned null/empty — wait 2s for SPA to settle and retry once
    await new Promise(r => setTimeout(r, 2000));
    const tree2 = await Promise.race([
      page.accessibility.snapshot({ interestingOnly: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CDP a11y retry timeout')), 10000)),
    ]);
    if (tree2) {
      const results = [], seen = new Set();
      walkA11yTree(tree2, results, seen);
      if (results.length >= 3) return results;
    }
  } catch (_) {
    // CDP a11y API unavailable or timed out — fall through to JS fallback
  }

  return getA11yTreeViaJSFallback(page);
}

// Take accessibility tree snapshot of current page, return ref map + formatted list
export async function snapshot(page) {
  const nodes = await getA11yTree(page);
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
  const { role, name } = refObj;

  // Build ARIA locator — use .first() to handle multiple matches (e.g. YouTube has
  // several elements with the same ARIA role+name in different DOM layers)
  if (role && name) {
    return page.getByRole(role, { name, exact: false }).first();
  }
  if (name) {
    return page.getByText(name, { exact: false }).first();
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
  const path = buildPath(x0, y0, x1, y1);
  const dist = Math.hypot(x1 - x0, y1 - y0);

  // Human mouse speed: 40–90 px/s (Gaussian mean 65) — slow and deliberate
  const baseSpeed = clamp(gaussian(65, 12), 40, 90);
  const totalMs = (dist / baseSpeed) * 1000;
  const stepDelay = totalMs / path.length;

  // 25% chance: random mid-path freeze (user glanced elsewhere)
  const midPauseIdx = dist > 60 && Math.random() < 0.25
    ? Math.floor(path.length * (0.3 + Math.random() * 0.4))
    : -1;

  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i];
    await page.mouse.move(x, y);
    if (i === midPauseIdx) {
      await sleep(200 + Math.random() * 800);   // mid-path distraction pause
    } else {
      await sleep(Math.max(1, stepDelay + gaussian(0, stepDelay * 0.3)));
    }
  }

  // Micro-jitter at destination: hand tremor (3–6 tiny sub-pixel wiggles)
  if (dist > 15) {
    const jiggles = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < jiggles; j++) {
      await page.mouse.move(x1 + (Math.random() - 0.5) * 5, y1 + (Math.random() - 0.5) * 5);
      await sleep(18 + Math.random() * 45);
    }
    await page.mouse.move(x1, y1);
  }

  mouseState.x = x1;
  mouseState.y = y1;
}

// Click an element via bounding box — used when we have a locator
export async function humanClick(page, locator, mouseState) {
  let box;

  // Stage 1: standard visibility check
  try {
    await locator.waitFor({ state: 'visible', timeout: 8000 });
    box = await locator.boundingBox();
  } catch (_e1) {
    // Stage 2: scroll the element into view, then retry visibility
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      box = await locator.boundingBox();
    } catch (_e2) {
      // Stage 3: element is in DOM (attached) but not strictly "visible" by Playwright rules
      // (e.g. covered by overlay, zero-opacity, in shadow DOM). Get bbox directly via JS.
      try {
        await locator.waitFor({ state: 'attached', timeout: 5000 });
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

// Type with error rate 4–9% (default 6.5%), realization delay 600–1500ms
export async function humanType(page, text, { errorRate = 0.065 } = {}) {
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
  let remaining = Math.abs(totalPixels);

  while (remaining > 0) {
    const burstSize = Math.min(remaining, 80 + Math.random() * 200);
    remaining -= burstSize;
    const steps = 6 + Math.floor(Math.random() * 5);
    const totalWeight = (steps * (steps + 1)) / 2;
    for (let s = steps; s > 0; s--) {
      await page.mouse.wheel(0, sign * burstSize * (s / totalWeight));
      await sleep(14 + Math.random() * 12);
    }

    // 28% chance: counter-scroll twitch — overscrolled, correcting
    if (Math.random() < 0.28) {
      const counterPx = 25 + Math.random() * 95;
      const counterSteps = 3 + Math.floor(Math.random() * 4);
      for (let s = 0; s < counterSteps; s++) {
        await page.mouse.wheel(0, -sign * counterPx / counterSteps);
        await sleep(16 + Math.random() * 22);
      }
      await sleep(180 + Math.random() * 420);
    }

    if (remaining > 0) await sleep(800 + Math.random() * 3500);
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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for full load so React/SPA initial render completes before returning
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
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
