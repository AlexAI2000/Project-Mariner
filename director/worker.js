// Worker thread — runs a single HumanBrowser session and processes tasks.
// All browser tasks MUST have mlProfileId set. Tasks without it are rejected.
// MultiLogin X browsers stay open between tasks — no close/reopen per task.

import { workerData, parentPort } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { dirname as pathDirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(__dir, '../task-queue');
const PENDING = join(QUEUE_DIR, 'pending');
const RUNNING = join(QUEUE_DIR, 'running');
const DONE = join(QUEUE_DIR, 'done');

const { workerId } = workerData;

function log(msg) {
  parentPort.postMessage({ type: 'log', workerId, msg });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── MultiLogin X browser management ─────────────────────────────────────────

async function getOrStartBrowser(task) {
  // Hard enforcement: every browser task must go through a MultiLogin X profile.
  if (!task.mlProfileId) {
    throw new Error(
      'BLOCKED: mlProfileId is missing from this task. ' +
      'All browser work must go through a MultiLogin X profile. ' +
      'Use node /data/executor/pa-lookup.js <clientId> <platform> to get the profile ID, ' +
      'then include mlProfileId in the task.'
    );
  }

  const { startProfile, readRegistry, writeRegistry, removeFromRegistry } =
    await import('../multilogin/multilogin.js');

  const { HumanBrowser } = await import('../human-browser/index.js');

  // Check registry for an already-open browser for this profile
  const registry = readRegistry();
  const entry = registry[task.mlProfileId];

  if (entry) {
    try {
      const browser = new HumanBrowser();
      await browser.connectCDP(entry.cdpUrl);
      log(`reused open MultiLogin X profile ${task.mlProfileId}`);
      return { browser, isMultiLogin: true };
    } catch (e) {
      log(`stale registry entry for ${task.mlProfileId} — restarting (${e.message})`);
      removeFromRegistry(task.mlProfileId);
    }
  }

  // Start a fresh MultiLogin X profile (startProfile writes registry internally)
  log(`starting MultiLogin X profile ${task.mlProfileId}...`);
  const cdpUrl = await startProfile(task.mlProfileId, task.folderId || null);

  const browser = new HumanBrowser();
  await browser.connectCDP(cdpUrl);
  log(`MultiLogin X profile ${task.mlProfileId} started and connected`);
  return { browser, isMultiLogin: true };
}

// ── Task execution ────────────────────────────────────────────────────────────

async function runTask(task) {
  const { browser, isMultiLogin } = await getOrStartBrowser(task);

  try {
    for (const step of task.steps) {
      log(`step: ${step.action} ${step.target || step.text || step.url || step.selector || ''}`);
      switch (step.action) {
        case 'goto':
          await browser.goto(step.url);
          break;
        case 'click':
          await browser.click(step.selector);
          break;
        case 'type':
          if (step.selector) await browser.click(step.selector);
          await sleep(200 + Math.random() * 200);
          await browser.type(step.text);
          break;
        case 'press':
          await browser.press(step.key);
          break;
        case 'scroll':
          await browser.scroll(step.pixels || 500, step.direction || 'down');
          break;
        case 'wait':
          await sleep(step.ms || 1000);
          break;
        case 'openTab':
          await browser.openNewTab(step.url);
          break;
        case 'closeTab':
          await browser.closeTab();
          break;
        case 'screenshot':
          await browser.screenshot(step.path || `/tmp/screenshot-${Date.now()}.png`);
          break;
        case 'getPageText':
          step._result = await browser.getPageText();
          break;

        case 'fill':
          // fill: click selector then clear and type text
          if (step.selector) await browser.click(step.selector);
          await sleep(150 + Math.random() * 150);
          await browser.page.keyboard.down('Control');
          await browser.page.keyboard.press('KeyA');
          await browser.page.keyboard.up('Control');
          await sleep(100);
          await browser.type(step.text || step.value || '');
          break;

        case 'snapshot': {
          // snapshot: return ARIA tree + interactive elements with stable numeric refs
          const snapshot = await browser.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll(
              'a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="textbox"],[contenteditable]'
            ));
            return els.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }).map((el, i) => ({
              ref: `e${i + 1}`,
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || '',
              role: el.getAttribute('role') || '',
              label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 80) || '',
              id: el.id || '',
              name: el.getAttribute('name') || '',
              value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : '',
              href: el.href || '',
            }));
          });
          step._result = { ref: step.ref || 'snapshot', elements: snapshot, url: browser.page.url() };
          break;
        }

        case 'act': {
          // act: interact with an element from a previous snapshot by numeric ref index
          // Requires a prior snapshot step in the same task
          const snapshotStep = task.steps.find(s => s.action === 'snapshot' && s._result);
          if (!snapshotStep) throw new Error('act requires a prior snapshot step');
          const els = snapshotStep._result.elements || [];
          const target = els.find(e => e.ref === step.ref);
          if (!target) throw new Error(`act: ref "${step.ref}" not found in snapshot`);
          const kind = step.kind || 'click';
          // Find element index in page by re-running the same querySelectorAll
          const refIdx = parseInt(step.ref.replace('e', ''), 10) - 1;
          if (kind === 'click') {
            await browser.page.evaluate((idx) => {
              const nodeList = document.querySelectorAll(
                'a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="textbox"],[contenteditable]'
              );
              const visibles = Array.from(nodeList).filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              if (visibles[idx]) visibles[idx].click();
            }, refIdx);
          } else if (kind === 'type') {
            await browser.type(step.text || '');
          }
          step._result = { acted: true, ref: step.ref, kind };
          break;
        }

        case 'getPageImages': {
          // Return all img elements with src, alt, dimensions
          const sel = step.selector || 'img';
          step._result = await browser.page.evaluate((s) => {
            return Array.from(document.querySelectorAll(s)).map(img => ({
              src: img.src,
              currentSrc: img.currentSrc,
              alt: img.alt || '',
              width: img.naturalWidth,
              height: img.naturalHeight,
            })).filter(img => img.src && img.src.length > 0);
          }, sel);
          break;
        }

        case 'detectCaptcha': {
          // Detect CAPTCHA type and site key on the current page.
          // Returns: { found, type, siteKey } where type is recaptcha2|recaptcha3|hcaptcha|funcaptcha|turnstile
          step._result = await browser.page.evaluate(() => {
            // reCAPTCHA v2 — data-sitekey on .g-recaptcha div
            const rc = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha, div[data-sitekey][class*="recaptcha"]');
            if (rc) return { found: true, type: 'recaptcha2', siteKey: rc.dataset.sitekey };

            // reCAPTCHA — any element with data-sitekey (fallback)
            const anySiteKey = document.querySelector('[data-sitekey]');
            if (anySiteKey) {
              const sk = anySiteKey.dataset.sitekey;
              // Check if it's from turnstile script
              const tsScript = document.querySelector('script[src*="turnstile"]');
              if (tsScript) return { found: true, type: 'turnstile', siteKey: sk };
              return { found: true, type: 'recaptcha2', siteKey: sk };
            }

            // hCaptcha
            const hc = document.querySelector('.h-captcha, [data-hcaptcha-sitekey], iframe[src*="hcaptcha"]');
            if (hc) {
              const sk = hc.dataset.sitekey || hc.dataset.hcaptchaSitekey || '';
              return { found: true, type: 'hcaptcha', siteKey: sk };
            }

            // FunCaptcha / Arkose Labs
            const fc = document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"], #FunCaptcha, [id*="arkose"]');
            if (fc || document.querySelector('script[src*="arkoselabs"]')) {
              return { found: true, type: 'funcaptcha', siteKey: null };
            }

            // Cloudflare Turnstile (script-only, no data-sitekey element)
            if (document.querySelector('script[src*="turnstile"], .cf-turnstile')) {
              const cf = document.querySelector('.cf-turnstile');
              return { found: true, type: 'turnstile', siteKey: cf?.dataset?.sitekey || null };
            }

            // reCAPTCHA v3 (invisible — detected via script only)
            if (document.querySelector('script[src*="recaptcha/api.js"]')) {
              const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
              let siteKey = null;
              for (const s of scripts) {
                const m = s.src.match(/[?&]render=([^&]+)/);
                if (m && m[1] !== 'explicit') { siteKey = m[1]; break; }
              }
              if (siteKey) return { found: true, type: 'recaptcha3', siteKey };
            }

            return { found: false, type: null, siteKey: null };
          });
          break;
        }

        case 'injectCaptchaToken': {
          // Inject a solved CAPTCHA token into the page.
          // step.token       — the solved token from 2Captcha
          // step.captchaType — recaptcha2 | recaptcha3 | hcaptcha | funcaptcha | turnstile
          if (!step.token) throw new Error('injectCaptchaToken: step.token is required');
          const captchaType = step.captchaType || 'recaptcha2';

          await browser.page.evaluate(({ token, captchaType }) => {
            if (captchaType === 'recaptcha2' || captchaType === 'recaptcha3') {
              // Set all g-recaptcha-response textareas
              document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(ta => {
                ta.value = token;
                ta.innerHTML = token;
                ta.style.display = 'block';
              });
              // Trigger registered reCAPTCHA callbacks
              try {
                const cfg = window.___grecaptcha_cfg;
                if (cfg?.clients) {
                  for (const client of Object.values(cfg.clients)) {
                    const cb = client?.callback || client?.U?.callback || client?.O?.callback;
                    if (typeof cb === 'function') { cb(token); break; }
                  }
                }
              } catch {}
            } else if (captchaType === 'hcaptcha') {
              document.querySelectorAll('textarea[name="h-captcha-response"], [name="g-recaptcha-response"]').forEach(ta => {
                ta.value = token;
                ta.style.display = 'block';
              });
              try { if (window.hcaptcha) window.hcaptcha.setResponse(token); } catch {}
            } else if (captchaType === 'turnstile') {
              document.querySelectorAll('input[name="cf-turnstile-response"]').forEach(el => { el.value = token; });
              try { if (window.turnstile) window.turnstile.reset(); } catch {}
            } else if (captchaType === 'funcaptcha') {
              // Arkose Labs: inject via postMessage and hidden input
              try {
                document.querySelectorAll('input[name*="captcha"], input[id*="fc-token"]').forEach(el => { el.value = token; });
                window.postMessage({ eventId: 'challenge-complete', payload: { sessionToken: token } }, '*');
              } catch {}
            }
          }, { token: step.token, captchaType });

          await sleep(500);
          step._result = { injected: true, captchaType, tokenPreview: step.token.slice(0, 30) + '...' };
          log(`injectCaptchaToken: injected ${captchaType} token`);
          break;
        }

        case 'finalClose': {
          // Humanized session end: natural reading dwell then stop the MultiLogin X profile.
          // This should be the LAST step in the last task of a session.
          // After this, the MultiLogin X browser process is fully stopped and removed from registry.
          const profileId = task.mlProfileId;

          // Simulate a natural user wrapping up: scroll around for 20–80 seconds
          const dwellMs = 20000 + Math.random() * 60000;
          const scrollCount = Math.max(3, Math.floor(dwellMs / 4000));
          for (let c = 0; c < scrollCount; c++) {
            const dir = Math.random() > 0.35 ? 'down' : 'up';
            const px = 150 + Math.floor(Math.random() * 500);
            try { await browser.scroll(px, dir); } catch {}
            await sleep(2500 + Math.random() * 3000);
          }

          // Stop the MultiLogin X profile (kills Mimic browser, cleans registry)
          if (profileId) {
            const { stopProfile } = await import('../multilogin/multilogin.js');
            await stopProfile(profileId);
            log(`finalClose: stopped MultiLogin X profile ${profileId}`);
          }

          step._result = { closed: true, profileId: profileId || null };
          break;
        }

        case 'downloadImage': {
          // Download an image from a URL or CSS selector to a local file.
          // step.url   — direct URL (optional, takes priority)
          // step.selector — CSS selector for <img> (used when no url)
          // step.path  — output file path (required)
          const outPath = step.path;
          if (!outPath) throw new Error('downloadImage: step.path is required');
          mkdirSync(pathDirname(outPath), { recursive: true });

          let imageUrl = step.url;
          if (!imageUrl && step.selector) {
            imageUrl = await browser.page.evaluate((sel) => {
              const el = document.querySelector(sel);
              return el ? (el.currentSrc || el.src) : null;
            }, step.selector);
          }
          if (!imageUrl) throw new Error('downloadImage: no image URL found');

          // Use browser-context fetch so cookies are included automatically.
          // Works for blob: URLs, authenticated Google URLs, and regular URLs.
          const bytes = await browser.page.evaluate(async (url) => {
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) throw new Error(`fetch ${resp.status} ${resp.statusText}`);
            const buf = await resp.arrayBuffer();
            return Array.from(new Uint8Array(buf));
          }, imageUrl);

          writeFileSync(outPath, Buffer.from(bytes));
          const size = statSync(outPath).size;
          log(`downloadImage: saved ${size} bytes → ${outPath}`);
          step._result = { downloadedTo: outPath, bytes: size, url: imageUrl };
          break;
        }

        default:
          log(`unknown action: ${step.action}`);
      }
    }

    const results = task.steps
      .filter(s => s._result)
      .map(s => s._result);

    return { success: true, results, workerId };
  } finally {
    // NEVER close a MultiLogin X browser — it must stay open for subsequent tasks.
    // The MultiLogin X Mimic process (with its proxy and fingerprint) persists.
    // The CDP connection is simply abandoned and cleaned up by GC.
    if (!isMultiLogin) {
      await browser.close();
    }
  }
}

// ── Main polling loop ─────────────────────────────────────────────────────────

async function main() {
  log('ready');
  parentPort.postMessage({ type: 'ready', workerId });

  while (true) {
    let files;
    try { files = readdirSync(PENDING); } catch { files = []; }

    const taskFile = files.find(f => f.endsWith('.json'));

    if (taskFile) {
      const pendingPath = join(PENDING, taskFile);
      const runningPath = join(RUNNING, taskFile);
      const donePath = join(DONE, taskFile);

      try {
        renameSync(pendingPath, runningPath);
      } catch {
        await sleep(100);
        continue;
      }

      let task;
      try {
        task = JSON.parse(readFileSync(runningPath, 'utf8'));
      } catch (e) {
        log(`failed to read task: ${e.message}`);
        continue;
      }

      log(`claimed task ${task.id}`);
      parentPort.postMessage({ type: 'busy', workerId, taskId: task.id });

      let result;
      try {
        result = await runTask(task);
      } catch (e) {
        result = { success: false, error: e.message, workerId };
        log(`task ${task.id} failed: ${e.message}`);
      }

      task.result = result;
      task.completedAt = Date.now();
      writeFileSync(donePath, JSON.stringify(task, null, 2));
      try { unlinkSync(runningPath); } catch {}

      log(`completed task ${task.id}`);
      parentPort.postMessage({ type: 'ready', workerId });
    } else {
      await sleep(500);
    }
  }
}

main().catch(e => {
  parentPort.postMessage({ type: 'error', workerId, msg: e.message });
  process.exit(1);
});
