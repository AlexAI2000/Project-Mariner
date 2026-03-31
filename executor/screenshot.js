#!/usr/bin/env node
// screenshot.js — Takes a screenshot of a URL using the Mimic browser via MultiLogin X.
// Navigates to the page, waits for DOM to settle, dismisses all popups (cookies, country
// selectors, newsletters, promos — including those inside shadow DOM), then captures a
// 1440×900 PNG and fires a callback.
//
// Concurrency model: a single "screenshotter" MLX profile stays running permanently.
// Each request opens its own tab, does its work, then closes that tab.
// Multiple concurrent jobs each get an isolated tab with no interference.
// When account_id is provided, uses that account's MLX profile instead (for
// logged-in screenshots, e.g. LinkedIn profiles).
//
// Usage: node /data/executor/screenshot.js <url> <callbackUrl> <executionId> [accountId]

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { HumanBrowser } from '/data/human-browser/index.js';
import { clickAt as humanClickAt } from '/data/human-browser/src/mouse.js';
import {
  startProfile,
  createProfile,
  findProfileByAccountId,
} from '/data/multilogin/multilogin.js';

const [, , targetUrl, callbackUrl, executionId, accountId] = process.argv;

if (!targetUrl || !callbackUrl || !executionId) {
  process.stderr.write('[screenshot] Usage: node screenshot.js <url> <callbackUrl> <executionId> [accountId]\n');
  process.exit(1);
}

const SCREENSHOTTER_ID = 'screenshotter';
const SCREENSHOT_PATH = `/tmp/screenshot-${executionId}.png`;

// ── Callback ─────────────────────────────────────────────────────────────────

function fireCallback(payload) {
  return new Promise((resolve) => {
    // Write payload to a temp file — passing large base64 data inline via -d
    // causes `spawn E2BIG` (ARG_MAX exceeded) for any real website screenshot.
    const payloadPath = `/tmp/callback-${executionId}.json`;
    writeFileSync(payloadPath, JSON.stringify(payload));

    const proc = spawn('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', `@${payloadPath}`,
      '--max-time', '60',
      callbackUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let errOut = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { errOut += d; });
    proc.on('close', (code) => {
      try { unlinkSync(payloadPath); } catch {}
      process.stderr.write(`[screenshot] Callback fired (exit ${code}): ${(out + errOut).trim().slice(0, 200)}\n`);
      resolve();
    });
  });
}

// ── DOM settle — runs inside the browser page via page.evaluate ──────────────
// Resolves once no DOM mutations occur for 2s, or after 12s cap.

function domSettle() {
  return new Promise(resolve => {
    const CAP_MS = 12000, QUIET_MS = 2000;
    const cap = setTimeout(resolve, CAP_MS);
    let quiet = setTimeout(() => { clearTimeout(cap); resolve(); }, QUIET_MS);
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(() => { clearTimeout(cap); observer.disconnect(); resolve(); }, QUIET_MS);
    });
    if (document.body) {
      observer.observe(document.body, { subtree: true, childList: true, attributes: false, characterData: false });
    } else { resolve(); }
  });
}

// ── Redirect detector — runs inside the browser page via page.evaluate ────────
// Detects meta-refresh tags and redirect-text interstitials.
// Returns { type: 'meta', delayMs } or { type: 'text' } or null.

function detectRedirect() {
  // Meta-refresh tag
  const meta = document.querySelector('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]');
  if (meta) {
    const content = meta.getAttribute('content') || '';
    const m = content.match(/^(\d+)\s*(?:;\s*url=(.*))?$/i);
    if (m) return { type: 'meta', delayMs: parseInt(m[1]) * 1000 };
  }
  // Text-based redirect indicators (multilingual)
  const text = (document.body?.innerText || '').toLowerCase();
  const phrases = [
    'you will be redirected', 'you are being redirected', 'redirecting to',
    'wird weitergeleitet', 'sie werden weitergeleitet',  // German
    'vous allez être redirigé', 'redirection en cours',  // French
    'siendo redirigido', 'redirigiendo a',               // Spanish
    'sta per essere reindirizzato',                      // Italian
    'wordt u doorgestuurd', 'wordt doorgestuurd',        // Dutch
    'omdirigerer', 'du omdirigeres',                     // Norwegian
  ];
  if (phrases.some(p => text.includes(p))) return { type: 'text' };
  return null;
}

// ── Popup element finder — runs inside the browser page via page.evaluate ─────
// Finds the next popup element to interact with and returns its bounding rect.
// Does NOT click — clicking happens from Node.js via humanClickAt() so the full
// human behavior stack fires: Bézier path, hover hesitation, 5–15px offset.
//
// Shadow DOM aware: walks all shadow roots recursively so cookie banners rendered
// inside shadow hosts (OneTrust, some Cookiebot variants) are also found.
//
// Returns { x, y, width, height } or null if no popup is present.

function findPopupElement() {
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.offsetParent === null && style.position !== 'fixed' && style.position !== 'sticky') return false;
    return true;
  }

  function rectOf(el) {
    if (!isVisible(el)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // Shadow-DOM-aware querySelector: checks the root, then recurses into shadow roots
  function shadowQuery(root, selector) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        const found = shadowQuery(host.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  // Shadow-DOM-aware querySelectorAll for interactive elements
  function shadowQueryAll(root, selector) {
    const results = Array.from(root.querySelectorAll(selector));
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        results.push(...shadowQueryAll(host.shadowRoot, selector));
      }
    }
    return results;
  }

  // ── Priority 1: Known cookie consent framework selectors (accept / allow) ──
  const cookieAcceptSelectors = [
    '#onetrust-accept-btn-handler',
    '#accept-recommended-btn-handler',
    '#onetrust-pc-btn-handler',
    '.cc-btn.cc-allow',
    '.cc-btn.cc-dismiss',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    '.trustarc-agree-btn',
    '#truste-consent-button',
    '[data-cookiebanner="accept_button"]',
    '.qc-cmp2-summary-buttons button:first-child',
    '#didomi-notice-agree-button',
    '[data-testid="cookie-policy-dialog-accept-button"]',
    '[aria-label="Accept all cookies"]',
    '[aria-label="Accept cookies"]',
    '[aria-label="Accept All"]',
    '[aria-label="Agree to all"]',
    'button[id*="accept"][id*="cookie"]',
    'button[class*="cookie-accept"]',
    'button[class*="cookie_accept"]',
    '#cookie-accept',
    '#btn-cookie-accept',
    '.cookie-consent__accept',
    '#gdpr-cookie-accept',
    '.gdpr-accept',
    '[data-gdpr-accept]',
    '.sp-privacy-manager__accept-btn',
    '.message-component.privacy-manager-accept',
  ];

  for (const sel of cookieAcceptSelectors) {
    try {
      const r = rectOf(shadowQuery(document, sel));
      if (r) return r;
    } catch (e) { /* ignore */ }
  }

  // ── Priority 2: Text-based accept / agree buttons (flat + shadow DOM) ──
  const acceptTexts = new Set([
    // English
    'accept all', 'accept all cookies', 'accept cookies', 'allow all cookies',
    'allow all', 'allow cookies', 'i accept', 'i accept all', 'i agree',
    'agree to all', 'agree all', 'agree & proceed', 'agree and proceed',
    'ok, i agree', 'consent to all', 'accept & continue', 'accept and continue',
    'got it', 'understood', 'i understand', 'ok, got it', 'i agree to all',
    'accept', 'agree', 'ok',
    // German
    'alle akzeptieren', 'alle cookies akzeptieren', 'cookies akzeptieren',
    'zustimmen', 'akzeptieren', 'einverstanden', 'ich stimme zu',
    'alle zulassen', 'zulassen', 'ja, ich stimme zu',
    // French
    'tout accepter', 'accepter tout', "j'accepte", 'accepter les cookies',
    'tout autoriser', 'autoriser les cookies', "j'accepte tout",
    // Spanish
    'aceptar todo', 'aceptar todos', 'aceptar cookies', 'acepto',
    'estoy de acuerdo', 'permitir todo', 'aceptar y continuar',
    // Italian
    'accetta tutto', 'accetta tutti', 'accetta cookies', 'accetto',
    'accetta tutti i cookie', 'consenti tutto',
    // Dutch
    'alles accepteren', 'alle cookies accepteren', 'akkoord',
    'ik ga akkoord', 'cookies accepteren', 'alles toestaan',
    // Norwegian
    'godta alle', 'jeg godtar', 'godta', 'aksepter alle',
    // Swedish
    'godkänn alla', 'jag godkänner', 'godkänn', 'acceptera alla',
    // Portuguese
    'aceitar tudo', 'aceitar todos', 'aceito', 'concordo',
    // Polish
    'zaakceptuj wszystkie', 'akceptuję', 'zgadzam się',
    // Danish
    'accepter alle', 'jeg accepterer', 'tillad alle',
    // Finnish
    'hyväksy kaikki', 'hyväksy', 'salli kaikki',
  ]);

  const clickables = shadowQueryAll(
    document,
    'button, [role="button"], a[href], input[type="button"], input[type="submit"]'
  );

  for (const el of clickables) {
    const raw = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
    if (acceptTexts.has(raw)) {
      const r = rectOf(el);
      if (r) return r;
    }
  }

  // ── Priority 3: Language / country selection — choose English or United States ──
  const langSelectors = [
    'button[lang="en"]', 'a[lang="en"]',
    '[data-language="en"]', '[data-locale="en"]', '[data-locale="en-US"]',
    '[data-country="US"]', '[data-country="us"]',
    '[aria-label="English"]', '[aria-label="United States"]',
  ];
  for (const sel of langSelectors) {
    try {
      const r = rectOf(shadowQuery(document, sel));
      if (r) return r;
    } catch (e) { /* ignore */ }
  }

  const langTexts = new Set([
    'english', 'united states', 'english (us)', 'english (united states)', 'en', 'en-us',
  ]);
  for (const el of clickables) {
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (langTexts.has(text)) {
      const r = rectOf(el);
      if (r) return r;
    }
  }

  // ── Priority 4: Close / dismiss other modals (newsletters, surveys, promos) ──
  const closeSelectors = [
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    'button[aria-label="Dismiss"]',
    'button[aria-label="dismiss"]',
    'button[aria-label="Schließen"]',  // German
    'button[aria-label="Fermer"]',     // French
    'button[aria-label="Cerrar"]',     // Spanish
    'button[aria-label="Chiudi"]',     // Italian
    'button[aria-label="Sluiten"]',    // Dutch
    'button[aria-label="Lukk"]',       // Norwegian
    'button[aria-label="Stäng"]',      // Swedish
    'button[aria-label="Fechar"]',     // Portuguese
    'button[aria-label="Zamknij"]',    // Polish
    '[data-dismiss="modal"]',
    '[data-dismiss="popup"]',
    '.modal-close', '.modal__close',
    '.popup-close', '.popup__close',
    '.dialog-close', '.dialog__close',
    '.overlay-close', '.close-modal',
    '[data-testid="close-button"]',
    '[data-testid="modal-close"]',
    '.close-btn', '.btn-close',
  ];
  for (const sel of closeSelectors) {
    try {
      const r = rectOf(shadowQuery(document, sel));
      if (r) return r;
    } catch (e) { /* ignore */ }
  }

  const closeTexts = new Set([
    // Universal symbols
    '×', '✕', '✖', '✗', 'x', '✘', '⨯', '⊗',
    // English
    'close', 'dismiss', 'no thanks', 'no, thanks',
    'not now', 'maybe later', 'skip', 'skip for now', 'no thank you',
    "don't show again", 'remind me later', 'exit',
    // German
    'schließen', 'ablehnen', 'nein, danke', 'nicht jetzt', 'später',
    'ohne zustimmung fortfahren', 'weiter ohne zu akzeptieren',
    // French
    'fermer', 'non merci', 'refuser', 'pas maintenant',
    'continuer sans accepter', 'tout refuser',
    // Spanish
    'cerrar', 'no gracias', 'rechazar', 'ahora no', 'rechazar todo',
    // Italian
    'chiudi', 'no grazie', 'rifiuta', 'non ora', 'rifiuta tutto',
    // Dutch
    'sluiten', 'nee bedankt', 'afwijzen', 'weiger alles',
    // Norwegian
    'lukk', 'nei takk', 'avvis', 'avvis alle',
    // Swedish
    'stäng', 'nej tack', 'avvisa', 'avvisa alla',
    // Portuguese
    'fechar', 'não obrigado', 'rejeitar', 'recusar',
    // Polish
    'zamknij', 'odmów', 'nie teraz',
    // Danish
    'luk', 'nej tak', 'afvis',
  ]);
  for (const el of clickables) {
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
    if (closeTexts.has(text)) {
      const r = rectOf(el);
      if (r) return r;
    }
  }

  // ── Priority 5: Last-resort — scan visible overlays for any tiny button
  // (1-2 chars) that looks like a × close control, regardless of language.
  const overlayHosts = Array.from(document.querySelectorAll('*')).filter(el => {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r2 = el.getBoundingClientRect();
    return r2.width > 100 && r2.height > 100;
  });
  for (const host of overlayHosts) {
    const btns = Array.from(host.querySelectorAll('button, [role="button"], a'));
    for (const btn of btns) {
      const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
      if (txt.length <= 2) {
        const r = rectOf(btn);
        if (r) return r;
      }
    }
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  let profileId = null;
  let folderId = null;
  let browser = null;
  let page = null;

  try {
    // Step 1: Resolve MLX profile — use account's own profile if account_id provided,
    // otherwise fall back to the generic screenshotter profile.
    if (accountId) {
      process.stderr.write(`[screenshot] Resolving profile for account: ${accountId}\n`);
      const clientJson = execSync(
        `node /data/clients/client-manager.js resolve ${accountId}`,
        { encoding: 'utf8', timeout: 30000 }
      ).trim();
      const client = JSON.parse(clientJson);
      profileId = client.mlProfileId;
      folderId = client.folderId || process.env.MULTILOGIN_FOLDER_ID;
      if (!profileId) throw new Error(`No MLX profile found for account ${accountId}`);
      process.stderr.write(`[screenshot] Using account profile: ${profileId}\n`);
    } else {
      process.stderr.write(`[screenshot] Resolving screenshotter profile...\n`);
      const existing = await findProfileByAccountId(SCREENSHOTTER_ID);
      if (existing) {
        profileId = existing.id || existing.profile_id;
        folderId = existing.folder_id || process.env.MULTILOGIN_FOLDER_ID;
        process.stderr.write(`[screenshot] Found existing profile: ${profileId}\n`);
      } else {
        process.stderr.write(`[screenshot] No screenshotter profile found — creating one...\n`);
        const created = await createProfile(SCREENSHOTTER_ID, 'web', 'Screenshotter', null);
        profileId = created.profileId;
        folderId = created.folderId;
        process.stderr.write(`[screenshot] Created profile: ${profileId}\n`);
      }
    }

    // Step 2: Ensure the profile's browser is running, then connect.
    // startProfile handles PROFILE_ALREADY_RUNNING — it reattaches to the
    // running browser and returns its CDP URL. The profile stays open after
    // this job completes so the next request reconnects instantly.
    process.stderr.write(`[screenshot] Starting/attaching profile ${profileId}...\n`);
    const cdpUrl = await startProfile(profileId, folderId);
    process.stderr.write(`[screenshot] CDP URL: ${cdpUrl}\n`);

    browser = new HumanBrowser();
    await browser.connectCDP(cdpUrl);

    // Open a fresh tab for this job — isolated from all other concurrent requests
    // that are also running in their own tabs inside the same browser.
    process.stderr.write(`[screenshot] Opening new tab...\n`);
    page = await browser.context.newPage();
    const mouseState = { x: null, y: null };

    await page.setViewportSize({ width: 1440, height: 900 });
    page.setDefaultTimeout(60000); // 60s for all page operations

    // Handle native browser dialogs (alert, confirm, prompt) on this tab only
    page.on('dialog', async (dialog) => {
      try { await dialog.dismiss(); } catch {}
    });

    // Step 3: Navigate and wait for network to go quiet
    process.stderr.write(`[screenshot] Navigating to ${targetUrl}...\n`);
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (navErr) {
      process.stderr.write(`[screenshot] networkidle timed out, retrying with domcontentloaded: ${navErr.message}\n`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    // Wait for the DOM to fully settle: MutationObserver resolves once no DOM
    // mutations occur for 2 consecutive seconds (capped at 12s).
    process.stderr.write(`[screenshot] Waiting for DOM to settle...\n`);
    try { await page.evaluate(domSettle); }
    catch (settleErr) { process.stderr.write(`[screenshot] DOM settle error (non-fatal): ${settleErr.message}\n`); }
    process.stderr.write(`[screenshot] DOM settled.\n`);

    // Step 3b: Detect redirect interstitials (meta-refresh or JS countdown pages).
    // If detected, wait for the navigation to complete then re-settle on the real page.
    const redirectInfo = await page.evaluate(detectRedirect).catch(() => null);
    if (redirectInfo) {
      const startUrl = page.url();
      if (redirectInfo.type === 'meta') {
        const waitMs = Math.min(redirectInfo.delayMs + 3000, 20000);
        process.stderr.write(`[screenshot] Meta-refresh redirect detected, waiting ${waitMs}ms...\n`);
        await page.waitForTimeout(waitMs);
      } else {
        process.stderr.write(`[screenshot] Redirect page detected, polling for navigation (up to 15s)...\n`);
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(1000);
          if (page.url() !== startUrl) break;
        }
      }
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
      process.stderr.write(`[screenshot] Redirected to ${page.url()}, re-settling DOM...\n`);
      try { await page.evaluate(domSettle); } catch {}
    }

    // Step 4: Dismiss all popups — up to 6 rounds, 1500ms between each.
    // findPopupElement() returns the bounding rect of the target element (no click).
    // humanClickAt() moves the mouse via Bézier curve, pauses with hover
    // hesitation (200–500ms), and clicks at a 5–15px offset from center.
    // Both flat DOM and shadow DOM roots are searched.
    process.stderr.write(`[screenshot] Dismissing popups...\n`);
    for (let round = 0; round < 6; round++) {
      let target = null;
      try {
        target = await page.evaluate(findPopupElement);
      } catch (evalErr) {
        process.stderr.write(`[screenshot] findPopupElement error (round ${round + 1}): ${evalErr.message}\n`);
      }
      if (!target) break;

      const cx = target.x + target.width / 2;
      const cy = target.y + target.height / 2;
      try {
        await humanClickAt(page, cx, cy, mouseState);
      } catch (clickErr) {
        process.stderr.write(`[screenshot] clickAt error (round ${round + 1}): ${clickErr.message}\n`);
        break;
      }

      process.stderr.write(`[screenshot] Dismissed popup round ${round + 1} at (${Math.round(cx)}, ${Math.round(cy)}).\n`);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1000);

    // Step 5: Take screenshot
    process.stderr.write(`[screenshot] Taking screenshot...\n`);
    await page.screenshot({ path: SCREENSHOT_PATH, type: 'png' });

    const imgBuffer = readFileSync(SCREENSHOT_PATH);
    const base64 = imgBuffer.toString('base64');
    try { unlinkSync(SCREENSHOT_PATH); } catch {}

    process.stderr.write(`[screenshot] Screenshot captured (${Math.round(imgBuffer.length / 1024)} KB). Firing callback...\n`);

    // Step 6: Fire success callback
    await fireCallback({
      execution_id: executionId,
      status: 'completed',
      url: targetUrl,
      screenshot: `data:image/png;base64,${base64}`,
      timestamp: Math.floor(Date.now() / 1000),
    });

    process.stderr.write(`[screenshot] Done.\n`);
  } catch (e) {
    process.stderr.write(`[screenshot] ERROR: ${e.message}\n${e.stack || ''}\n`);
    try {
      await fireCallback({
        execution_id: executionId,
        status: 'failed',
        url: targetUrl,
        error: e.message,
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (cbErr) {
      process.stderr.write(`[screenshot] Callback also failed: ${cbErr.message}\n`);
    }
  } finally {
    // Close just this tab
    if (page) {
      try { await page.close(); } catch {}
    }
    // Disconnect the Playwright CDP session so this process exits cleanly.
    // For connectOverCDP() browsers, close() only drops the WebSocket connection —
    // it does NOT kill the remote Mimic browser process, which stays running.
    if (browser && browser.browser) {
      try { await browser.browser.close(); } catch {}
    }
  }
}

run().catch(e => {
  process.stderr.write(`[screenshot] Fatal: ${e.message}\n`);
  process.exit(1);
});
