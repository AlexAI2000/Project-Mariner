#!/usr/bin/env node
// solve-captcha.js — 2Captcha API solver with MultiLogin X proxy routing.
//
// Usage:
//   node /data/captcha/solve-captcha.js [options]
//
// Options:
//   --type <type>         CAPTCHA type: recaptcha2 | recaptcha3 | hcaptcha | funcaptcha | turnstile | image
//   --site-key <key>      Site key from the page (required for recaptcha/hcaptcha/funcaptcha/turnstile)
//   --url <url>           Page URL where CAPTCHA appears (required)
//   --client-id <id>      Client ID for proxy lookup from clients.json (optional)
//   --action <action>     Action string for reCAPTCHA v3 (default: "submit")
//   --min-score <score>   Min score for reCAPTCHA v3 (default: 0.3)
//   --subdomain <host>    funcaptchaApiJSSubdomain for FunCaptcha
//   --image-b64 <data>    Base64 image data for image CAPTCHA type
//   --no-proxy            Skip proxy routing even if client has proxy config
//
// Output (stdout): JSON { success, token, error? }
// Exit 0 on success, 1 on failure.

import { readFileSync, existsSync } from 'fs';

const CONFIG_PATH   = '/data/captcha/captcha-config.json';
const CLIENTS_PATH  = '/data/clients/clients.json';

// ── Parse args ────────────────────────────────────────────────────────────────

function arg(flag, def = null) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return def;
  return process.argv[idx + 1] ?? def;
}
function flag(name) { return process.argv.includes(name); }

const type       = arg('--type', 'recaptcha2');
const siteKey    = arg('--site-key');
const pageUrl    = arg('--url');
const clientId   = arg('--client-id');
const action     = arg('--action', 'submit');
const minScore   = parseFloat(arg('--min-score', '0.3'));
const subdomain  = arg('--subdomain');
const imageB64   = arg('--image-b64');
const noProxy    = flag('--no-proxy');

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

// ── Load config ───────────────────────────────────────────────────────────────

if (!existsSync(CONFIG_PATH)) fail(`Config not found: ${CONFIG_PATH}`);
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

if (!config.apiKey || config.apiKey.includes('REPLACE')) {
  fail('2Captcha API key not configured. Edit /data/captcha/captcha-config.json and set "apiKey".');
}

// ── Load proxy from client ────────────────────────────────────────────────────

let proxy = null;
if (clientId && !noProxy && config.useProxy) {
  try {
    const clients = JSON.parse(readFileSync(CLIENTS_PATH, 'utf8'));
    const client  = clients[clientId];
    if (client?.proxy?.host) {
      proxy = {
        proxyType:     client.proxy.type     || 'http',
        proxyAddress:  client.proxy.host,
        proxyPort:     client.proxy.port,
        proxyLogin:    client.proxy.login     || undefined,
        proxyPassword: client.proxy.password  || undefined,
      };
    }
  } catch (e) {
    process.stderr.write(`[solve-captcha] Warning: could not read client proxy: ${e.message}\n`);
  }
}

// ── Build task payload ────────────────────────────────────────────────────────

function buildTask() {
  const proxyFields = proxy && config.useProxy ? proxy : {};
  const useProxyType = proxy ? type : type + 'Proxyless';

  switch (type) {
    case 'recaptcha2':
      return {
        type: proxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        ...proxyFields,
      };

    case 'recaptcha3':
      return {
        type: proxy ? 'RecaptchaV3Task' : 'RecaptchaV3TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        pageAction: action,
        minScore,
        ...proxyFields,
      };

    case 'hcaptcha':
      return {
        type: proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        ...proxyFields,
      };

    case 'funcaptcha':
      if (!siteKey) fail('--site-key required for funcaptcha (websitePublicKey)');
      return {
        type: proxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyless',
        websiteURL: pageUrl,
        websitePublicKey: siteKey,
        ...(subdomain ? { funcaptchaApiJSSubdomain: subdomain } : {}),
        ...proxyFields,
      };

    case 'turnstile':
      return {
        type: proxy ? 'TurnstileTask' : 'TurnstileTaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        ...proxyFields,
      };

    case 'image':
      if (!imageB64) fail('--image-b64 required for image CAPTCHA type');
      return {
        type: 'ImageToTextTask',
        body: imageB64,
      };

    default:
      fail(`Unknown CAPTCHA type: ${type}. Valid: recaptcha2, recaptcha3, hcaptcha, funcaptcha, turnstile, image`);
  }
}

// ── 2Captcha API calls ────────────────────────────────────────────────────────

async function createTask(task) {
  const body = JSON.stringify({ clientKey: config.apiKey, task });
  const res  = await fetch(`${config.baseUrl}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) fail(`createTask HTTP ${res.status}`);
  const data = await res.json();
  if (data.errorId !== 0) fail(`2Captcha createTask error ${data.errorId}: ${data.errorDescription || data.errorCode}`);
  return data.taskId;
}

async function getTaskResult(taskId) {
  const body = JSON.stringify({ clientKey: config.apiKey, taskId });
  const res  = await fetch(`${config.baseUrl}/getTaskResult`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) fail(`getTaskResult HTTP ${res.status}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!pageUrl && type !== 'image') fail('--url is required');
  if (!siteKey && !['image'].includes(type)) {
    if (['recaptcha2','recaptcha3','hcaptcha','funcaptcha','turnstile'].includes(type))
      fail('--site-key is required for this CAPTCHA type');
  }

  const task = buildTask();
  process.stderr.write(`[solve-captcha] Submitting ${task.type}${proxy ? ' (with proxy)' : ' (proxyless)'}...\n`);

  const taskId = await createTask(task);
  process.stderr.write(`[solve-captcha] Task ID: ${taskId}. Polling...\n`);

  const deadline = Date.now() + config.maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);

    const result = await getTaskResult(taskId);

    if (result.errorId !== 0) {
      fail(`2Captcha error ${result.errorId}: ${result.errorDescription || result.errorCode}`);
    }

    if (result.status === 'ready') {
      const sol    = result.solution;
      // Extract token — field name varies by CAPTCHA type
      const token  = sol.token || sol.gRecaptchaResponse || sol.text || sol.answer;
      if (!token) fail(`Solution returned but no token field found: ${JSON.stringify(sol)}`);

      process.stderr.write(`[solve-captcha] Solved in ${Math.round((Date.now() - (deadline - config.maxWaitMs)) / 1000)}s\n`);
      console.log(JSON.stringify({ success: true, token, taskId, cost: result.cost }));
      return;
    }

    process.stderr.write(`[solve-captcha] Still processing (status: ${result.status})...\n`);
  }

  fail(`Timeout after ${config.maxWaitMs / 1000}s — CAPTCHA not solved in time`);
}

main().catch(e => fail(e.message));
