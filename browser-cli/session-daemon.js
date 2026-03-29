#!/usr/bin/env node
// session-daemon.js — Persistent per-session browser process.
// One daemon per account session. Maintains CDP connection + tab registry.
// Communicates with exec.js via Unix socket (newline-delimited JSON-RPC).
//
// Usage: node session-daemon.js <sessionId> <cdpUrl> [--account <id>] [--platform <p>]
// Socket: /tmp/browser-cli-<sessionId>.sock
// PID:    /tmp/browser-cli-daemon-<sessionId>.pid

import { createServer, createConnection } from 'net';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// playwright-core lives in human-browser's node_modules
const require = createRequire(import.meta.url);
const { chromium } = require('/data/human-browser/node_modules/playwright-core/index.js');

import {
  snapshot,
  locatorForRef,
  humanClick,
  humanFill,
  humanType,
  humanNavigate,
  humanScroll,
  openBackgroundTab,
  breatheOnBackgroundTab,
  MAX_TABS_PER_SESSION,
} from './humanizer.js';

import {
  logSessionStart,
  logNavigate,
  logSnapshot,
  logAction,
  logTabOpen,
  logTabSwitch,
  logTabClose,
  logScroll,
  logWait,
  logError,
  logTaskComplete,
  logCheckpoint,
  logSessionEnd,
  logCaptchaDetected,
  logCaptchaInjected,
} from './jsonl-logger.js';

// ── Args ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const sessionId = args[0];
const cdpUrl = args[1];

if (!sessionId || !cdpUrl) {
  process.stderr.write('Usage: node session-daemon.js <sessionId> <cdpUrl>\n');
  process.exit(1);
}

const accountIdx = args.indexOf('--account');
const accountId = accountIdx >= 0 ? args[accountIdx + 1] : 'unknown';
const platformIdx = args.indexOf('--platform');
const platform = platformIdx >= 0 ? args[platformIdx + 1] : 'unknown';
const tasksIdx = args.indexOf('--tasks');
const tasksList = tasksIdx >= 0 ? args[tasksIdx + 1].split(',') : [];

const SOCKET_PATH = `/tmp/browser-cli-${sessionId}.sock`;
const PID_PATH = `/tmp/browser-cli-daemon-${sessionId}.pid`;

// ── State ──────────────────────────────────────────────────────────────────────

let browser = null;
let context = null;

// Tab registry: tabId (string) → { page, url }
const tabs = new Map();
let currentTabId = 'tab-0';
let tabCounter = 0;

// Per-tab snapshot ref cache: tabId → { refs: {eN: {...}}, url }
const snapshotCache = new Map();

// Mouse state per tab
const mouseStates = new Map();

// Session task tracking for checkpoints
let completedTasks = [];
let pendingTasks = [...tasksList];

function mouseState(tabId) {
  if (!mouseStates.has(tabId)) mouseStates.set(tabId, { x: null, y: null });
  return mouseStates.get(tabId);
}

function log(msg) {
  process.stderr.write(`[daemon:${sessionId}] ${msg}\n`);
}

// ── Page listener helper ───────────────────────────────────────────────────────

function attachPageListeners(tid, page) {
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      const entry = tabs.get(tid);
      if (entry) entry.url = frame.url();
    }
  });
  page.on('close', () => {
    log(`Page closed: ${tid} (${tabs.get(tid)?.url || '?'})`);
    tabs.delete(tid);
    if (currentTabId === tid) {
      // Auto-switch to another valid open tab
      const valid = [...tabs.entries()].find(([, e]) => !e.page.isClosed());
      if (valid) {
        currentTabId = valid[0];
        log(`Current tab ${tid} closed. Auto-switched to ${currentTabId}`);
      } else {
        log(`Current tab ${tid} closed. No other tabs available.`);
      }
    }
  });
}

// ── Browser init ───────────────────────────────────────────────────────────────

async function resolveWsUrl(rawUrl) {
  // If already a ws:// URL, use as-is
  if (rawUrl.startsWith('ws://') || rawUrl.startsWith('wss://')) return rawUrl;

  // HTTP fallback — fetch /json/version to get ws URL, with retries
  const base = rawUrl.replace(/\/$/, '');
  const versionUrl = `${base}/json/version`;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      log(`Resolving ws URL from ${versionUrl} (attempt ${attempt}/8)...`);
      const res = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.webSocketDebuggerUrl) {
        log(`Resolved ws URL: ${data.webSocketDebuggerUrl}`);
        return data.webSocketDebuggerUrl;
      }
      throw new Error('No webSocketDebuggerUrl in response');
    } catch (e) {
      log(`ws resolve attempt ${attempt} failed: ${e.message}`);
      if (attempt < 8) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error(`Could not resolve ws:// URL from ${rawUrl} after 8 attempts`);
}

async function connect() {
  const wsUrl = await resolveWsUrl(cdpUrl);
  log(`Connecting to CDP: ${wsUrl}`);
  browser = await chromium.connectOverCDP(wsUrl);
  const contexts = browser.contexts();
  context = contexts[0] || await browser.newContext();
  context.setDefaultTimeout(600000);       // 10 min default for all Playwright actions
  context.setDefaultNavigationTimeout(600000); // 10 min for navigations

  // Clean start: close all existing pages except one, then register it as tab-0
  const pages = context.pages();
  if (pages.length > 1) {
    log(`Closing ${pages.length - 1} stale tabs for clean start`);
    // Keep the first page, close the rest
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close(); } catch {}
    }
  }

  if (pages.length > 0 && !pages[0].isClosed()) {
    tabs.set('tab-0', { page: pages[0], url: pages[0].url(), openedAt: Date.now() });
    attachPageListeners('tab-0', pages[0]);
    tabCounter = 1;
    currentTabId = 'tab-0';
  } else {
    // Open initial blank page
    const p = await context.newPage();
    tabs.set('tab-0', { page: p, url: 'about:blank', openedAt: Date.now() });
    attachPageListeners('tab-0', p);
    tabCounter = 1;
    currentTabId = 'tab-0';
  }

  // Auto-register any new page the browser opens (link clicks that open new tabs,
  // NTP shortcut navigations, etc.) — but do NOT auto-follow.
  // The agent must explicitly switch tabs via switch-tab command.
  context.on('page', (newPage) => {
    const tid = `tab-${tabCounter++}`;
    tabs.set(tid, { page: newPage, url: 'about:blank', openedAt: Date.now() });
    attachPageListeners(tid, newPage);
    // Do NOT change currentTabId — agent stays on the tab it was working on.
    // This prevents the silent tab mismatch where snapshot shows tab-0 but
    // commands execute on a newly-opened tab.
    log(`New tab auto-registered: ${tid} (NOT following — agent stays on ${currentTabId})`);
  });

  log(`Connected. ${tabs.size} tab(s) active.`);
  logSessionStart(sessionId, { accountId, platform, tasks: tasksList });
  writeFileSync(PID_PATH, String(process.pid));
}

// ── Tab helpers ────────────────────────────────────────────────────────────────

function getPage(tabId) {
  const tid = tabId || currentTabId;
  const entry = tabs.get(tid);

  // Check closed AND detached-frame — both mean the page object is unusable
  const isBroken = !entry || entry.page.isClosed() ||
    (entry.page.mainFrame && entry.page.mainFrame().isDetached());

  if (!isBroken) return entry.page;

  // Recovery: re-sync with what's actually open in the browser context
  const contextPages = context?.pages() || [];
  for (const p of contextPages) {
    if (p.isClosed()) continue;
    // Check if already tracked
    const tracked = [...tabs.entries()].find(([, e]) => e.page === p);
    if (tracked) {
      // It's tracked — use it and update currentTabId
      currentTabId = tracked[0];
      log(`Recovered: switched currentTabId to ${currentTabId} (${p.url()})`);
      return p;
    }
    // Untracked page — register it and follow it
    const newTid = `tab-${tabCounter++}`;
    tabs.set(newTid, { page: p, url: p.url(), openedAt: Date.now() });
    attachPageListeners(newTid, p);
    currentTabId = newTid;
    log(`Recovered untracked page as ${newTid}: ${p.url()}`);
    return p;
  }

  // Final fallback: any tracked tab still open
  const validEntry = [...tabs.entries()].find(([, e]) => !e.page.isClosed());
  if (validEntry) {
    currentTabId = validEntry[0];
    log(`Recovered via fallback tab: ${currentTabId}`);
    return validEntry[1].page;
  }

  throw new Error(`Tab ${tid} is closed and no recovery page available in browser context`);
}

function getTabState() {
  return [...tabs.entries()].map(([tid, { url }]) => ({ tabId: tid, url }));
}

async function openTab(url) {
  // Enforce MAX_TABS_PER_SESSION: evict oldest non-primary, non-current background tab
  if (tabs.size >= MAX_TABS_PER_SESSION) {
    const candidates = [...tabs.entries()]
      .filter(([tid]) => tid !== 'tab-0' && tid !== currentTabId)
      .sort((a, b) => (a[1].openedAt || 0) - (b[1].openedAt || 0));
    if (candidates.length > 0) {
      const [evictId] = candidates[0];
      log(`Tab limit reached (${tabs.size}/${MAX_TABS_PER_SESSION}). Auto-closing oldest: ${evictId}`);
      await closeTab(evictId);
    }
  }

  const tid = `tab-${tabCounter++}`;
  const page = await context.newPage();
  tabs.set(tid, { page, url: 'about:blank', openedAt: Date.now() });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) tabs.get(tid).url = frame.url();
  });
  await humanNavigate(page, url);
  tabs.get(tid).url = page.url();
  logTabOpen(sessionId, { tabId: tid, url: page.url() });
  log(`Opened ${tid} → ${url} (${tabs.size}/${MAX_TABS_PER_SESSION} tabs)`);
  return tid;
}

async function switchTab(tabId) {
  const page = getPage(tabId);
  const prev = currentTabId;
  await page.bringToFront();
  currentTabId = tabId;
  logTabSwitch(sessionId, { fromTabId: prev, toTabId: tabId });
}

async function closeTab(tabId) {
  const tid = tabId || currentTabId;
  const entry = tabs.get(tid);
  if (!entry) throw new Error(`Tab ${tid} not found`);
  if (!entry.page.isClosed()) await entry.page.close();
  tabs.delete(tid);
  logTabClose(sessionId, { tabId: tid });
  if (currentTabId === tid) {
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      currentTabId = remaining[remaining.length - 1];
      await getPage(currentTabId).bringToFront();
    }
  }
}

// ── Command handlers ───────────────────────────────────────────────────────────

async function cmd_snapshot({ tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  // Hard timeout: 1 hour — the snapshot function handles its own timing internally
  // (11-15s settle + stability check up to 60s). This outer guard is just a safety net.
  const result = await Promise.race([
    snapshot(page),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Snapshot daemon hard timeout: 3600s')), 3600000)),
  ]);
  snapshotCache.set(tid, { refs: result.refs, url: result.url });
  logSnapshot(sessionId, { tabId: tid, url: result.url, refCount: result.refCount });

  // Build tab bar: all open tabs with current marked by *
  const tabBar = [...tabs.entries()]
    .filter(([, e]) => !e.page.isClosed())
    .map(([t, e]) => {
      const label = (e.url || 'blank').replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
      return t === tid ? `[${t}: ${label}]*` : `[${t}: ${label}]`;
    })
    .join('  ');

  return {
    ok: true,
    tabId: tid,
    tabBar,
    tabCount: tabs.size,
    url: result.url,
    title: result.title,
    refCount: result.refCount,
    list: result.list,
  };
}

async function cmd_act({ ref, kind, text, key, tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  const cache = snapshotCache.get(tid);

  if (!ref) throw new Error('ref is required');
  if (!cache) throw new Error('No snapshot cached for this tab. Run snapshot first.');

  const refObj = cache.refs[ref];
  if (!refObj) throw new Error(`Ref ${ref} not found in last snapshot. Re-snapshot the page.`);

  const locator = locatorForRef(page, refObj);
  if (!locator) throw new Error(`Cannot build locator for ref ${ref}`);

  const ms = mouseState(tid);
  let coords = { x: 0, y: 0 };

  if (kind === 'click') {
    coords = await humanClick(page, locator, ms);
    logAction(sessionId, { action: 'act', ref, kind: 'click', tabId: tid, label: refObj.name, ...coords, result: 'ok' });
  } else if (kind === 'fill') {
    if (text === undefined) throw new Error('text is required for fill');
    await humanFill(page, locator, String(text), ms);
    logAction(sessionId, { action: 'act', ref, kind: 'fill', tabId: tid, label: refObj.name, text: String(text || '').slice(0, 80), result: 'ok' });
  } else if (kind === 'type') {
    if (text === undefined) throw new Error('text is required for type');
    // Click the element to focus it first, then type keystroke-by-keystroke
    coords = await humanClick(page, locator, ms);
    // Human-like thinking pause: 5–11 seconds (lets UI settle + looks natural)
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 6000));
    // Auto-clear: select all existing text + delete it (human-like timing)
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));   // 300-800ms before Ctrl+A
    await page.keyboard.down('Control');
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));   // 200-500ms hold
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));   // 300-800ms before Backspace
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));   // 400-800ms before typing
    await humanType(page, text);
    logAction(sessionId, { action: 'act', ref, kind: 'type', tabId: tid, text: String(text || '').slice(0, 80), result: 'ok' });
  } else if (kind === 'check') {
    const box = await locator.boundingBox();
    if (box) coords = await humanClick(page, locator, ms);
    logAction(sessionId, { action: 'act', ref, kind: 'check', tabId: tid, label: refObj.name, result: 'ok' });
  } else if (kind === 'press') {
    const keyName = text || key;
    if (!keyName) throw new Error('text or key is required for press (e.g. --text "Enter")');
    // Brief human pause before pressing a key (1–3 seconds)
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    await page.keyboard.press(String(keyName));
    logAction(sessionId, { action: 'act', ref, kind: 'press', tabId: tid, text: String(keyName), result: 'ok' });
  } else {
    throw new Error(`Unknown kind: ${kind}. Use: click|fill|type|check|press`);
  }

  return { ok: true, ref, kind, label: refObj.name, ...coords };
}

async function cmd_navigate({ url, tabId } = {}) {
  if (!url) throw new Error('url is required');
  const tid = tabId || currentTabId;
  const page = getPage(tid);

  try {
    await humanNavigate(page, url);
  } catch (err) {
    // Chrome replaces the CDP target when navigating away from chrome:// WebUI pages
    // (e.g. chrome://new-tab-page/). The old target is destroyed and a new one is
    // opened — causing Playwright's page.goto() to throw "Target page … has been closed".
    // Our context.on('page') listener auto-registers the new tab, but fires slightly
    // after the error propagates. Yield the event loop, then recover from the new tab.
    const isTargetClosed = /closed|detached/i.test(err.message);
    if (!isTargetClosed) throw err;

    log(`cmd_navigate: CDP target closed during goto to ${url} — recovering...`);
    // Yield the event loop so context.on('page') and page.on('close') can fire
    await new Promise(r => setTimeout(r, 500));

    // Fast path: currentTabId was updated by the auto-follow listener
    const newTid = currentTabId;
    if (newTid !== tid || !tabs.has(tid)) {
      let rPage;
      try { rPage = getPage(newTid); } catch {}
      if (rPage && !rPage.isClosed()) {
        try { await rPage.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch {}
        const finalUrl = rPage.url();
        if (tabs.has(newTid)) tabs.get(newTid).url = finalUrl;
        snapshotCache.delete(newTid);
        logNavigate(sessionId, { tabId: newTid, url: finalUrl });
        log(`cmd_navigate: recovered on tab ${newTid} at ${finalUrl}`);
        return { ok: true, tabId: newTid, url: finalUrl };
      }
    }

    // Fallback: scan all live pages in context
    for (const p of (context?.pages() || [])) {
      if (p.isClosed()) continue;
      const existing = [...tabs.entries()].find(([, e]) => e.page === p);
      let recovTid = existing ? existing[0] : `tab-${tabCounter++}`;
      if (!existing) {
        tabs.set(recovTid, { page: p, url: p.url(), openedAt: Date.now() });
        attachPageListeners(recovTid, p);
      }
      currentTabId = recovTid;
      try { await p.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch {}
      const finalUrl = p.url();
      tabs.get(recovTid).url = finalUrl;
      snapshotCache.delete(recovTid);
      logNavigate(sessionId, { tabId: recovTid, url: finalUrl });
      log(`cmd_navigate: recovered via context scan on tab ${recovTid} at ${finalUrl}`);
      return { ok: true, tabId: recovTid, url: finalUrl };
    }

    throw new Error(`Navigation to ${url} failed: CDP target closed and no recovery page found`);
  }

  const finalUrl = page.url();
  if (tabs.has(tid)) tabs.get(tid).url = finalUrl;
  snapshotCache.delete(tid); // invalidate cached refs
  logNavigate(sessionId, { tabId: tid, url: finalUrl });
  return { ok: true, tabId: tid, url: finalUrl };
}

async function cmd_open_tab({ url } = {}) {
  if (!url) throw new Error('url is required');
  const tid = await openTab(url);
  currentTabId = tid;
  return { ok: true, tabId: tid, url: tabs.get(tid)?.url };
}

async function cmd_switch_tab({ tabId } = {}) {
  if (!tabId) throw new Error('tabId is required');
  await switchTab(tabId);
  return { ok: true, tabId, url: tabs.get(tabId)?.url };
}

async function cmd_close_tab({ tabId } = {}) {
  await closeTab(tabId);
  return { ok: true };
}

async function cmd_scroll({ pixels, direction, tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  await humanScroll(page, pixels || 400, direction || 'down');
  logScroll(sessionId, { tabId: tid, pixels: pixels || 400, direction: direction || 'down' });
  return { ok: true };
}

async function cmd_wait({ ms } = {}) {
  const duration = Math.min(ms || 2000, 600000); // up to 10 min — no arbitrary short cap
  await new Promise(r => setTimeout(r, duration));
  logWait(sessionId, { ms: duration });
  return { ok: true };
}

async function cmd_screenshot({ path, tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  const screenshotPath = path || `/tmp/screenshot-${sessionId}-${Date.now()}.png`;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 600000 });
  } catch (e) {
    if (e.message.includes('Timeout')) {
      log(`Screenshot timed out on ${tid} — continuing without screenshot`);
      return { ok: true, path: null, warning: 'Screenshot timed out but session is still active' };
    }
    throw e;
  }
  return { ok: true, path: screenshotPath };
}

async function cmd_get_text({ tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  const text = await page.evaluate(() => document.body?.innerText || '');
  const url = page.url();
  return { ok: true, tabId: tid, url, text: text.slice(0, 8000) };
}

async function cmd_background_breathe({ tabId } = {}) {
  if (!tabId) throw new Error('tabId required');
  const bgEntry = tabs.get(tabId);
  const primaryEntry = tabs.get(currentTabId);
  if (!bgEntry || !primaryEntry) throw new Error('Tab not found');
  await breatheOnBackgroundTab(bgEntry.page, primaryEntry.page);
  return { ok: true };
}

async function cmd_checkpoint({ task, status, note, completedTasksList, pendingTasksList } = {}) {
  // Update tracking from explicit lists if provided
  if (completedTasksList) completedTasks = completedTasksList;
  if (pendingTasksList) pendingTasks = pendingTasksList;

  // If single task completion
  if (task && status === 'done' && !completedTasks.includes(task)) {
    completedTasks.push(task);
    pendingTasks = pendingTasks.filter(t => t !== task);
  }

  logTaskComplete(sessionId, { task, status, note });
  logCheckpoint(sessionId, {
    completedTasks,
    pendingTasks,
    tabState: getTabState(),
    currentTabId,
    daemonPid: process.pid,
  });
  return { ok: true, completedTasks, pendingTasks };
}

async function cmd_get_status() {
  return {
    ok: true,
    sessionId,
    accountId,
    platform,
    pid: process.pid,
    currentTabId,
    tabs: getTabState(),
    completedTasks,
    pendingTasks,
  };
}

async function cmd_press_key({ key, tabId } = {}) {
  if (!key) throw new Error('key is required');
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  await page.keyboard.press(key);
  logAction(sessionId, { action: 'press_key', key, tabId: tid, result: 'ok' });
  return { ok: true, key };
}

async function cmd_stop() {
  logSessionEnd(sessionId, { status: 'stopped', summary: `Completed: ${completedTasks.join(', ')}` });
  log('Stop command received. Shutting down.');
  setTimeout(() => process.exit(0), 500);
  return { ok: true };
}

async function cmd_detect_captcha({ tabId } = {}) {
  const tid = tabId || currentTabId;
  const page = getPage(tid);
  const url = page.url();

  const result = await page.evaluate(() => {
    // reCAPTCHA v2 — .g-recaptcha with data-sitekey
    const rc = document.querySelector('.g-recaptcha[data-sitekey], div[data-sitekey][class*="recaptcha"]');
    if (rc) return { found: true, type: 'recaptcha2', siteKey: rc.dataset.sitekey };

    // Cloudflare Turnstile (check before generic data-sitekey)
    const cf = document.querySelector('.cf-turnstile');
    if (cf || document.querySelector('script[src*="turnstile"]')) {
      return { found: true, type: 'turnstile', siteKey: cf?.dataset?.sitekey || null };
    }

    // Generic data-sitekey — reCAPTCHA v2 fallback
    const anySiteKey = document.querySelector('[data-sitekey]');
    if (anySiteKey) return { found: true, type: 'recaptcha2', siteKey: anySiteKey.dataset.sitekey };

    // hCaptcha
    const hc = document.querySelector('.h-captcha, [data-hcaptcha-sitekey], iframe[src*="hcaptcha.com"]');
    if (hc) return { found: true, type: 'hcaptcha', siteKey: hc.dataset.sitekey || hc.dataset.hcaptchaSitekey || '' };

    // FunCaptcha / Arkose Labs
    const fc = document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"], #FunCaptcha, [id*="arkose"]');
    if (fc) return { found: true, type: 'funcaptcha', siteKey: null };

    // reCAPTCHA v3 — invisible, check script tags for render= param
    if (document.querySelector('script[src*="recaptcha/api.js"]')) {
      const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
      for (const s of scripts) {
        const m = s.src.match(/[?&]render=([^&]+)/);
        if (m && m[1] !== 'explicit') return { found: true, type: 'recaptcha3', siteKey: m[1] };
      }
    }

    // Text-based fallback detection
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (
      bodyText.includes('verify you are human') ||
      bodyText.includes('not a robot') ||
      bodyText.includes('prove you are human') ||
      bodyText.includes('security check') ||
      bodyText.includes('checking your browser') ||
      bodyText.includes('please stand by') ||
      bodyText.includes('before you continue')
    ) {
      return { found: true, type: 'unknown', siteKey: null };
    }

    return { found: false };
  });

  if (result.found) {
    logCaptchaDetected(sessionId, { tabId: tid, captchaType: result.type, siteKey: result.siteKey, url });
  }

  return { ok: true, tabId: tid, url, ...result };
}

async function cmd_inject_captcha_token({ token, captchaType, tabId } = {}) {
  if (!token) throw new Error('token is required');
  const typ = captchaType || 'recaptcha2';
  const tid = tabId || currentTabId;
  const page = getPage(tid);

  await page.evaluate(({ token, typ }) => {
    if (typ === 'recaptcha2' || typ === 'recaptcha3') {
      // Set all g-recaptcha-response textareas (hidden inputs)
      document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(ta => {
        ta.innerHTML = token;
        try { Object.defineProperty(ta, 'value', { get: () => token, configurable: true }); } catch {}
      });
      // Fire grecaptcha callbacks
      try {
        const clients = window.___grecaptcha_cfg?.clients;
        if (clients) {
          Object.values(clients).forEach(c => {
            const keys = Object.keys(c);
            for (const k of keys) {
              const cb = c[k]?.callback;
              if (typeof cb === 'function') { try { cb(token); } catch {} }
              else if (typeof cb === 'string' && typeof window[cb] === 'function') { try { window[cb](token); } catch {} }
            }
          });
        }
      } catch {}
    } else if (typ === 'hcaptcha') {
      document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]').forEach(ta => {
        ta.innerHTML = token;
        try { Object.defineProperty(ta, 'value', { get: () => token, configurable: true }); } catch {}
      });
      try { if (window.hcaptcha) window.hcaptcha.setResponse(token); } catch {}
    } else if (typ === 'turnstile') {
      document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(el => { el.value = token; });
      try { if (window.turnstile) window.turnstile.reset(); } catch {}
    } else if (typ === 'funcaptcha') {
      try {
        if (window.ArkoseEnforcement) window.ArkoseEnforcement.challengeCompleted({ token });
        document.querySelectorAll('input[name*="captcha"], input[id*="fc-token"]').forEach(el => { el.value = token; });
      } catch {}
    }
  }, { token, typ });

  // Humanized pause post-injection (800–1500ms) before the agent clicks submit
  await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 700)));

  logCaptchaInjected(sessionId, { tabId: tid, captchaType: typ });
  logAction(sessionId, { action: 'inject_captcha_token', kind: 'inject', tabId: tid, label: `${typ} token`, text: token.slice(0, 30) + '…', result: 'ok' });

  return { ok: true, captchaType: typ, tokenPreview: token.slice(0, 30) + '…' };
}

// ── Dispatch table ─────────────────────────────────────────────────────────────

const COMMANDS = {
  snapshot: cmd_snapshot,
  act: cmd_act,
  navigate: cmd_navigate,
  open_tab: cmd_open_tab,
  switch_tab: cmd_switch_tab,
  close_tab: cmd_close_tab,
  scroll: cmd_scroll,
  wait: cmd_wait,
  screenshot: cmd_screenshot,
  get_text: cmd_get_text,
  background_breathe: cmd_background_breathe,
  checkpoint: cmd_checkpoint,
  get_status: cmd_get_status,
  press_key: cmd_press_key,
  stop: cmd_stop,
  detect_captcha: cmd_detect_captcha,
  inject_captcha_token: cmd_inject_captcha_token,
};

// ── Unix socket server ─────────────────────────────────────────────────────────

function startServer() {
  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }

  const server = createServer(socket => {
    let buffer = '';

    socket.on('data', chunk => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop(); // keep incomplete line

      for (const line of parts) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
          socket.write(JSON.stringify({ id: null, error: 'Invalid JSON' }) + '\n');
          continue;
        }

        const { id, method, params } = msg;
        const handler = COMMANDS[method];

        if (!handler) {
          socket.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + '\n');
          continue;
        }

        handler(params || {}).then(result => {
          socket.write(JSON.stringify({ id, result }) + '\n');
        }).catch(err => {
          logError(sessionId, { error: err.message, context: method });
          socket.write(JSON.stringify({ id, error: err.message }) + '\n');
        });
      }
    });

    socket.on('error', () => {});
  });

  server.listen(SOCKET_PATH, () => {
    log(`Socket ready at ${SOCKET_PATH}`);
  });

  server.on('error', err => {
    log(`Server error (non-fatal, daemon continues): ${err.message}`);
    // Do NOT exit — the daemon must stay alive. Socket errors are recoverable.
  });
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

function cleanup() {
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_PATH); } catch {}
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// ── Crash guard — Playwright internal errors must NOT kill the daemon ──────────

process.on('uncaughtException', (err) => {
  log(`Uncaught exception (non-fatal, daemon continues): ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection (non-fatal, daemon continues): ${reason}`);
});

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await connect();
    startServer();
    log(`Daemon running. PID=${process.pid}`);
  } catch (err) {
    log(`Fatal startup error: ${err.message}\n${err.stack}`);
    cleanup();
    process.exit(1);
  }
}

main();
