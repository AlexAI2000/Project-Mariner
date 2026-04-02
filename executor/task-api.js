#!/usr/bin/env node
// task-api.js — HTTP API server for programmatic task submission from external systems (e.g. Lovable).
//
// Start: node /data/executor/task-api.js
// Port:  18790 (override with TASK_API_PORT env var)
// Auth:  Bearer token (set TASK_API_TOKEN env var, defaults to the openclaw hooks token)
//
// ── Endpoints ──
//
// POST /api/session
//   Body: { clientId, clientName?, tasks: [{id, label, steps},...] }
//   Creates a background session. Returns { sessionId, status, isNew }
//   isNew=true means MultiLogin X profile was auto-created for this client.
//
// GET /api/session/:id
//   Returns full session state: { sessionId, status, tasks, result, clientContext }
//
// POST /api/task
//   Body: { clientId, steps: [...] }
//   Synchronous single-task dispatch. Waits up to 5 min for result.
//   Returns { success, results, error }
//
// GET /api/clients
//   Returns list of all registered clients.
//
// POST /api/clients
//   Body: { clientId, name, proxy?, phone? }
//   Ensures a client entry exists. Returns { clientId, isNew }
//
// GET /api/health
//   Returns { ok: true, uptime }
//
// POST /api/v1/working-session   (Lovable/Mariner working session bridge)
//   Body: { session_id?, client_name, account_id, working_session: { tasks: [{task_type, details?}] },
//           timeout?, auth_token, callback_url, callback_metadata: { execution_id } }
//   Looks up MLX profile by account_id, opens the browser, fires callback_url when browser is ready.
//   Returns { session_id, account_id, execution_id, status, message }
//
// GET /api/v1/working-session/:id
//   Returns session state in Lovable format.
//
// POST /api/v1/provision-profile  (MLX profile-only provisioning, no agent)
//   Body: { account_id, client_name?, proxy?, auth_token, callback_url, callback_metadata: { execution_id } }
//   proxy (optional): "host:port:username:password" — if omitted, a proxy is auto-generated via MLX proxy API.
//   Creates proxy + MLX browser profile. Does NOT launch an AI agent or open a browser session.
//   Fires callback_url with { execution_id, account_id, status, mlProfileId, folderId, isNew }.
//   Returns { session_id, account_id, execution_id, status, message }
//
// ──────────────────────────────────────────────────────────────────────────────

import { createServer } from 'http';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { runBrowserUseTask } from '/data/browser-use/bridge.js';

const PORT = parseInt(process.env.TASK_API_PORT || '18790');
const AUTH_TOKEN = process.env.TASK_API_TOKEN || '9O0IWy8zIq5tGAIEC5YrF9MXxZlhiEbq';
const MARINER_API_TOKEN = process.env.MARINER_API_TOKEN || AUTH_TOKEN;
const MARINER_WEBHOOK_URL = process.env.MARINER_WEBHOOK_URL || 'https://wlowwprkjdhvfecsxsvp.supabase.co/functions/v1/mariner-webhook';
const SESSIONS_DIR = '/data/sessions';
const startTime = Date.now();

// ── Security: Allowed CORS origins ────────────────────────────────────────────
// Only these origins may call the API from a browser context.
const ALLOWED_ORIGINS = (process.env.TASK_API_ALLOWED_ORIGINS || [
  'https://wlowwprkjdhvfecsxsvp.supabase.co',
  'https://lovable.app',
].join(',')).split(',').map(o => o.trim()).filter(Boolean);

// ── Security: Allowed callback URL domains (SSRF protection) ──────────────────
// callback_url must be HTTPS and its hostname must match one of these suffixes.
const ALLOWED_CALLBACK_SUFFIXES = (process.env.TASK_API_ALLOWED_CALLBACK_DOMAINS || [
  '.supabase.co',
  '.lovable.app',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

// Private/loopback IP patterns — always blocked as callback targets
const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc00:|fe80:)/i;

function isAllowedCallbackUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (PRIVATE_IP_RE.test(host)) return false;
  return ALLOWED_CALLBACK_SUFFIXES.some(suffix => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}

// ── Security: Rate limiting ───────────────────────────────────────────────────
// Sliding window: max RATE_MAX_REQUESTS per RATE_WINDOW_MS per IP.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30;
const rateMap = new Map(); // ip → [timestamp, ...]

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const hits = (rateMap.get(ip) || []).filter(t => t > windowStart);
  hits.push(now);
  rateMap.set(ip, hits);
  return hits.length <= RATE_MAX_REQUESTS;
}

// Purge stale entries every 5 minutes to avoid memory leak
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, hits] of rateMap) {
    const filtered = hits.filter(t => t > cutoff);
    if (filtered.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, filtered);
  }
}, 300_000);

// ── Security: Request body size limit ────────────────────────────────────────
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

// ── Gateway auto-pair ─────────────────────────────────────────────────────────
// Auto-approves any pending openclaw device pair requests so the gateway stays
// connected without manual intervention. Called at startup and before every
// session dispatch.

function autoApproveGatewayPairs() {
  try {
    const result = spawnSync('openclaw', ['devices', 'list'], {
      encoding: 'utf8',
      timeout: 10000,
      env: process.env,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    // Pending request IDs are UUIDs (8-4-4-4-12 hex format) in the first column
    const uuids = [...output.matchAll(/│\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*│/g)]
      .map(m => m[1]);
    for (const id of uuids) {
      const r = spawnSync('openclaw', ['devices', 'approve', id], {
        encoding: 'utf8',
        timeout: 8000,
        env: process.env,
      });
      process.stderr.write(`[task-api] Auto-approved gateway pair ${id}: ${(r.stdout || r.stderr || '').trim().slice(0, 120)}\n`);
    }
  } catch (e) {
    process.stderr.write(`[task-api] autoApproveGatewayPairs error: ${e.message}\n`);
  }
}

// Run immediately on startup and then every 60s in case new pair requests arrive
autoApproveGatewayPairs();
setInterval(autoApproveGatewayPairs, 60_000);

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token === AUTH_TOKEN;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function err(res, status, message) {
  json(res, status, { error: message });
}

// ── Body parsing ──────────────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large (max 512 KB)'));
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Child process helpers ─────────────────────────────────────────────────────

function runNode(scriptArgs, timeoutMs = 60000) {
  const result = spawnSync(process.execPath, scriptArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || '',
    exitCode: result.status,
  };
}

function launchSession(plan, timeoutMs = 30000) {
  const result = spawnSync(process.execPath, [
    '/data/executor/launch.js',
    JSON.stringify(plan),
  ], { encoding: 'utf8', timeout: timeoutMs });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `launch.js exited ${result.status}`);
  }
  return JSON.parse(result.stdout.trim());
}

function dispatchTaskSync(taskBody, timeoutSec = 300) {
  const result = spawnSync(process.execPath, [
    '/data/director/dispatch.js',
    JSON.stringify(taskBody),
    '--timeout', String(timeoutSec),
  ], { encoding: 'utf8', timeout: (timeoutSec + 30) * 1000 });

  if (result.status === 0) {
    return { success: true, result: JSON.parse(result.stdout.trim()) };
  }
  return { success: false, error: result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}` };
}

// ── Session reader ────────────────────────────────────────────────────────────

function readSession(sessionId) {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleCreateSession(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return err(res, 400, 'tasks array is required and must be non-empty');
  }

  const plan = {
    clientId: body.clientId || null,
    clientName: body.clientName || null,
    tasks: body.tasks,
  };

  try {
    const launched = launchSession(plan);
    const session = readSession(launched.sessionId);
    json(res, 202, {
      sessionId: launched.sessionId,
      status: session?.status || 'starting',
      pid: launched.pid,
      sessionPath: launched.sessionPath,
      clientContext: session?.clientContext || null,
      message: 'Session started in background. Poll GET /api/session/:id for status.',
    });
  } catch (e) {
    err(res, 500, `Failed to launch session: ${e.message}`);
  }
}

async function handleGetSession(req, res, sessionId) {
  if (!sessionId) return err(res, 400, 'sessionId is required');

  const session = readSession(sessionId);
  if (!session) return err(res, 404, `Session "${sessionId}" not found`);

  json(res, 200, {
    sessionId: session.id,
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt || null,
    clientId: session.clientId || null,
    clientContext: session.clientContext || null,
    tasks: session.tasks.map(t => ({
      id: t.id,
      label: t.label,
      type: t.type || 'browser',
      status: t.status,
      startedAt: t.startedAt || null,
      completedAt: t.completedAt || null,
      result: t.result,
    })),
    result: session.result || null,
    lastHeartbeat: session.lastHeartbeat || null,
    error: session.error || null,
  });
}

async function handleDispatchTask(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    return err(res, 400, 'steps array is required and must be non-empty');
  }

  const taskBody = {
    steps: body.steps,
    clientId: body.clientId || null,
    mlProfileId: body.mlProfileId || null,
  };
  // Remove nulls
  Object.keys(taskBody).forEach(k => taskBody[k] === null && delete taskBody[k]);

  const timeoutSec = Math.min(body.timeoutSec || 300, 540);

  const result = dispatchTaskSync(taskBody, timeoutSec);
  json(res, result.success ? 200 : 422, result);
}

async function handleListClients(req, res) {
  const r = runNode(['/data/clients/client-manager.js', 'list'], 10000);
  if (!r.ok) return err(res, 500, r.stderr || 'Failed to list clients');
  try { json(res, 200, JSON.parse(r.stdout)); }
  catch { err(res, 500, 'Failed to parse client list'); }
}

async function handleCreateClient(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!body.clientId) return err(res, 400, 'clientId is required');

  // Run ensure command
  const cliArgs = ['/data/clients/client-manager.js', 'ensure', body.clientId];
  if (body.name) cliArgs.push(body.name);

  const r = runNode(cliArgs, 10000);
  if (!r.ok) return err(res, 500, r.stderr || 'Failed to create client');

  // If proxy or phone provided, save them via client-manager module
  if (body.proxy || body.phone) {
    const saveScript = `
      import { saveClientField } from '/data/clients/client-manager.js';
      ${body.proxy ? `saveClientField(${JSON.stringify(body.clientId)}, 'proxy', ${JSON.stringify(body.proxy)});` : ''}
      ${body.phone ? `saveClientField(${JSON.stringify(body.clientId)}, 'phone', ${JSON.stringify(body.phone)});` : ''}
    `;
    spawnSync(process.execPath, ['--input-type=module'], {
      input: saveScript,
      encoding: 'utf8',
      timeout: 10000,
    });
  }

  try {
    const client = JSON.parse(r.stdout);
    json(res, 200, { clientId: body.clientId, ...client, isNew: r.stderr.includes('Created new client') });
  } catch {
    json(res, 200, { clientId: body.clientId, ok: true });
  }
}

// ── Lovable / Mariner bridge ──────────────────────────────────────────────────

function checkMarinerAuth(req, body) {
  const bodyToken = body.auth_token || '';
  const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const validTokens = [MARINER_API_TOKEN, AUTH_TOKEN].filter(Boolean);
  return validTokens.includes(bodyToken) || validTokens.includes(headerToken);
}

// POST /api/v1/working-session
// Accepts working session payload from Lovable. Dispatches all tasks to director agent.
// Fires callback_url with execution_id on completion.
async function handleMarinerWorkingSession(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — invalid auth_token');
  }

  const accountId = body.account_id;
  const clientName = body.client_name || accountId;
  const callbackUrl = body.callback_url || MARINER_WEBHOOK_URL;
  const callbackMetadata = body.callback_metadata || {};
  const executionId = callbackMetadata.execution_id || randomUUID();
  const incomingTasks = body.working_session?.tasks;

  if (!accountId) return err(res, 400, 'account_id is required');
  if (!Array.isArray(incomingTasks) || incomingTasks.length === 0) {
    return err(res, 400, 'working_session.tasks must be a non-empty array');
  }

  // SSRF protection: validate callback_url points to an allowed external HTTPS endpoint
  if (body.callback_url && !isAllowedCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be an HTTPS URL pointing to an allowed domain (supabase.co or lovable.app)');
  }

  const safeAccountId = accountId.replace(/'/g, '');
  const safeClientName = clientName.replace(/'/g, '').replace(/"/g, '');
  const tasksJson = JSON.stringify(incomingTasks);

  // Detect if any tasks use browser_use (natural language prompt tasks)
  const hasBrowserUseTasks = incomingTasks.some(t => t.task_type === 'browser_use');

  let sessionTasks;

  if (hasBrowserUseTasks) {
    // ── browser-use path: natural language tasks via browser-use Python agent ──
    // Ensure client first, then run each browser_use task individually
    sessionTasks = [
      {
        id: 'ensure-client',
        type: 'bash',
        label: `Ensure client entry for ${accountId}`,
        command: `node /data/clients/client-manager.js ensure '${safeAccountId}' '${safeClientName}'`,
      },
      ...incomingTasks.map((t, idx) => ({
        id: t.id || `bu-task-${idx + 1}`,
        type: 'browser_use',
        prompt: t.prompt || t.details?.prompt || `Execute: ${t.task_type}`,
        label: (t.prompt || t.task_type || `Task ${idx + 1}`).slice(0, 80),
        maxSteps: t.max_steps || 30,
        timeout: t.timeout || 900,
        systemPrompt: t.system_prompt || null,
        injectAsUserPrompt: !!t.inject_as_user_prompt,
      })),
    ];
  } else {
    // ── Legacy path: dispatch to Mariner director agent via trigger-working-session.js ──
    sessionTasks = [
      {
        id: 'ensure-client',
        type: 'bash',
        label: `Ensure client entry for ${accountId}`,
        command: `node /data/clients/client-manager.js ensure '${safeAccountId}' '${safeClientName}'`,
      },
      {
        id: 'execute-working-session',
        type: 'bash',
        label: `Execute working session (${incomingTasks.length} task${incomingTasks.length !== 1 ? 's' : ''}) for ${clientName}`,
        command:
          `node /data/executor/trigger-working-session.js ` +
          `'${safeAccountId}' '${safeClientName}' ` +
          `${JSON.stringify(tasksJson)} ` +
          `${JSON.stringify(callbackUrl)} ` +
          `${JSON.stringify(executionId)}`,
      },
    ];
  }

  const plan = {
    clientId: accountId,
    clientName,
    callbackUrl,
    callbackMetadata,
    stepCallbackUrl: body.step_callback_url || null,
    tasks: sessionTasks,
  };

  try {
    const launched = launchSession(plan);
    return json(res, 202, {
      session_id: launched.sessionId,
      lovable_session_id: body.session_id || null,
      account_id: accountId,
      execution_id: executionId,
      status: 'starting',
      message: `Working session started for ${clientName}. Browser will be opened and ready shortly.`,
    });
  } catch (e) {
    return err(res, 500, `Failed to launch working session: ${e.message}`);
  }
}

// POST /api/v1/provision-profile
// Creates proxy + MLX browser profile for an account. Does NOT launch an AI agent.
// Fires callback_url with { execution_id, account_id, status, mlProfileId, folderId, isNew }.
async function handleProvisionProfile(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — invalid auth_token');
  }

  const accountId = body.account_id;
  const clientName = body.client_name || accountId;
  const callbackUrl = body.callback_url || MARINER_WEBHOOK_URL;
  const callbackMetadata = body.callback_metadata || {};
  const executionId = callbackMetadata.execution_id || randomUUID();

  // Proxy: accept object { host, port, username, password } or string "host:port:user:pass"
  let proxyString = '';
  if (body.proxy) {
    if (typeof body.proxy === 'object') {
      const p = body.proxy;
      if (p.host && p.port && p.username && p.password) {
        proxyString = `${p.host}:${p.port}:${p.username}:${p.password}`;
      }
    } else if (typeof body.proxy === 'string') {
      proxyString = body.proxy;
    }
  }

  if (!accountId) return err(res, 400, 'account_id is required');

  if (body.callback_url && !isAllowedCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be HTTPS on an allowed domain (supabase.co or lovable.app)');
  }

  const safeAccountId = accountId.replace(/'/g, '');
  const safeClientName = clientName.replace(/'/g, '').replace(/"/g, '');

  const plan = {
    clientId: accountId,
    clientName,
    callbackUrl,
    callbackMetadata,
    tasks: [{
      id: 'provision-profile',
      type: 'bash',
      label: `Create proxy + MLX profile for ${clientName}`,
      command:
        `node /data/executor/provision-profile.js ` +
        `'${safeAccountId}' '${safeClientName}' ` +
        `${JSON.stringify(callbackUrl)} ` +
        `${JSON.stringify(executionId)} ` +
        `${JSON.stringify(proxyString)}`,
    }],
  };

  try {
    const launched = launchSession(plan);
    return json(res, 202, {
      session_id: launched.sessionId,
      account_id: accountId,
      execution_id: executionId,
      status: 'starting',
      message: `Profile provisioning started for ${clientName}.`,
    });
  } catch (e) {
    return err(res, 500, `Failed to launch provisioning: ${e.message}`);
  }
}

// POST /api/v1/generate-post
// Drives the PhantomWriter browser UI to generate a LinkedIn lead magnet post.
// Uses the named MLX browser profile (already logged in). Fires callback_url with the generated post.
async function handleGeneratePost(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — invalid auth_token');
  }

  const mlxProfileName = body.mlx_profile_name;
  const resourceType = body.resource_type;
  const resourceOutline = body.resource_outline || '';
  const regenerateInput = body.regenerate_input || '';
  const callbackUrl = body.callback_url;
  const callbackMetadata = body.callback_metadata || {};
  const executionId = callbackMetadata.execution_id || randomUUID();

  if (!mlxProfileName) return err(res, 400, 'mlx_profile_name is required');
  if (!resourceType) return err(res, 400, 'resource_type is required');
  if (!resourceOutline && !regenerateInput) {
    return err(res, 400, 'resource_outline is required (or regenerate_input for a standalone regeneration)');
  }
  if (!callbackUrl) return err(res, 400, 'callback_url is required');

  const validTypes = ['info_document', 'automation_workflow', 'video_masterclass', 'mail_report', 'database', 'software'];
  if (!validTypes.includes(resourceType)) {
    return err(res, 400, `resource_type must be one of: ${validTypes.join(', ')}`);
  }

  if (!isAllowedCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be an HTTPS URL pointing to an allowed domain (supabase.co or lovable.app)');
  }

  // Pre-generate a session ID so we can pass it to the script and return it immediately.
  const sessionId = `pw-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // Base64-encode outline and regenerate args — they may contain backticks or other
  // shell-special characters that would break the bash -c invocation.
  const outlineB64 = Buffer.from(resourceOutline).toString('base64');
  const regenB64 = Buffer.from(regenerateInput).toString('base64');

  const sessionTasks = [
    {
      id: 'phantomwriter-generate',
      type: 'bash',
      label: `Generate PhantomWriter lead magnet post (${resourceType}) via ${mlxProfileName}`,
      command:
        `node /data/phantomwriter/run-phantomwriter.js ` +
        `${JSON.stringify(mlxProfileName)} ` +
        `${JSON.stringify(resourceType)} ` +
        `${JSON.stringify(outlineB64)} ` +
        `${JSON.stringify(regenB64)} ` +
        `${JSON.stringify(callbackUrl)} ` +
        `${JSON.stringify(executionId)} ` +
        `${JSON.stringify(sessionId)}`,
    },
  ];

  const plan = {
    clientId: null,
    clientName: 'PhantomWriter',
    callbackUrl,
    callbackMetadata,
    tasks: sessionTasks,
  };

  try {
    launchSession(plan);
    return json(res, 202, {
      session_id: sessionId,
      execution_id: executionId,
      status: 'starting',
      message: `PhantomWriter post generation started (${resourceType}). Callback will fire when complete.`,
    });
  } catch (e) {
    return err(res, 500, `Failed to launch PhantomWriter task: ${e.message}`);
  }
}

async function handleMarinerGetSession(req, res, sessionId) {
  if (!sessionId) return err(res, 400, 'sessionId is required');
  const session = readSession(sessionId);
  if (!session) return err(res, 404, `Session "${sessionId}" not found`);

  json(res, 200, {
    session_id: session.id,
    account_id: session.clientId,
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt || null,
    tasks: session.tasks.map(t => ({
      id: t.id,
      label: t.label,
      status: t.status,
      result: t.result,
    })),
    result: session.result || null,
    error: session.error || null,
  });
}

// ── Screenshot endpoint ───────────────────────────────────────────────────────

// Relaxed callback URL validator for the screenshot endpoint.
// Allows any http/https URL as long as it's not a private/loopback IP.
function isAllowedScreenshotCallbackUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (PRIVATE_IP_RE.test(u.hostname)) return false;
  return true;
}

// POST /api/v1/screenshot
// Body: { url, callback_url, execution_id, account_id?, auth_token? }
// Responds immediately with 200, then spawns screenshot.js in the background.
// screenshot.js navigates to url, dismisses all popups, takes a 1440×900 PNG,
// and POSTs the result to callback_url with { execution_id, status, screenshot, url, timestamp }.
// When account_id is provided, uses that account's MLX browser profile (logged in)
// instead of the generic screenshotter profile.
async function handleScreenshot(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — provide Authorization: Bearer <token> or auth_token in body');
  }

  const { url: targetUrl, callback_url: callbackUrl, execution_id: executionId, account_id: accountId } = body;

  if (!targetUrl) return err(res, 400, 'url is required');
  if (!callbackUrl) return err(res, 400, 'callback_url is required');
  if (!executionId) return err(res, 400, 'execution_id is required');

  // Validate target URL
  try { new URL(targetUrl); } catch { return err(res, 400, 'url must be a valid URL'); }

  // Validate callback URL (relaxed — any non-private http/https URL)
  if (!isAllowedScreenshotCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be a valid http/https URL and cannot point to a private IP');
  }

  // Acknowledge immediately — screenshot runs in a detached background process
  json(res, 200, {
    status: 'received',
    execution_id: executionId,
    message: 'Screenshot job queued. Result will be POSTed to callback_url when complete.',
  });

  // Spawn screenshot.js detached so it survives independently of this request
  spawn(process.execPath, [
    '/data/executor/screenshot.js',
    targetUrl,
    callbackUrl,
    String(executionId),
    accountId || '',
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
}

// ── Lemlist endpoints ─────────────────────────────────────────────────────────
//
// POST /api/v1/lemlist/filter-leads
//   Body: { filters: [...], _original_campaign_id?, callback_url, callback_metadata: { execution_id }, auth_token? }
//   Spawns lemlist-filter.js which opens the Lead_Collector MLX profile, navigates to
//   app.lemlist.com/database/people and applies every filter. Fires callback_url when done.
//
// POST /api/v1/lemlist/collect-leads
//   Body: { list_name, lead_count?, create_list_if_missing?, callback_url, callback_metadata: { execution_id }, auth_token? }
//   Spawns lemlist-collect.js which selects all visible leads, pushes them to a contacts
//   list, exports the list as CSV and fires callback_url with { csv_content (base64), csv_rows }.

async function handleLemlistFilterLeads(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — provide Authorization: Bearer <token> or auth_token in body');
  }

  const { filters, callback_url: callbackUrl, callback_metadata } = body;
  const executionId = callback_metadata?.execution_id;

  if (!filters || !Array.isArray(filters)) return err(res, 400, 'filters (array) is required');
  if (!callbackUrl) return err(res, 400, 'callback_url is required');
  if (!executionId) return err(res, 400, 'callback_metadata.execution_id is required');
  if (!isAllowedScreenshotCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be a valid http/https URL and cannot point to a private IP');
  }

  const payloadPath = `/tmp/lemlist-filter-payload-${executionId}.json`;
  writeFileSync(payloadPath, JSON.stringify(body));

  json(res, 200, {
    status: 'received',
    execution_id: executionId,
    message: `Lemlist filter job queued (${filters.length} filters). Result will be POSTed to callback_url when complete.`,
  });

  spawn(process.execPath, [
    '/data/lemlist/lemlist-filter.js',
    payloadPath,
    callbackUrl,
    String(executionId),
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
}

async function handleLemlistCollectLeads(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — provide Authorization: Bearer <token> or auth_token in body');
  }

  const { list_name, callback_url: callbackUrl, callback_metadata } = body;
  const executionId = callback_metadata?.execution_id;

  if (!list_name) return err(res, 400, 'list_name is required');
  if (!callbackUrl) return err(res, 400, 'callback_url is required');
  if (!executionId) return err(res, 400, 'callback_metadata.execution_id is required');
  if (!isAllowedScreenshotCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be a valid http/https URL and cannot point to a private IP');
  }

  const payloadPath = `/tmp/lemlist-collect-payload-${executionId}.json`;
  writeFileSync(payloadPath, JSON.stringify(body));

  json(res, 200, {
    status: 'received',
    execution_id: executionId,
    list_name,
    message: `Lemlist collect job queued for list "${list_name}". CSV will be POSTed to callback_url when complete.`,
  });

  spawn(process.execPath, [
    '/data/lemlist/lemlist-collect.js',
    payloadPath,
    callbackUrl,
    String(executionId),
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
}

// ── Browser-Use endpoint ─────────────────────────────────────────────────────
//
// POST /api/v1/browser-use
//   Starts a browser-use AI agent with custom tool "Manage Task List".
//   The agent fetches tasks on-the-fly from the provided tool_endpoint.
//   Step-by-step logs are POSTed to log_endpoint in real time.
//
// ── Active browser-use sessions (for kill endpoint) ─────────────────────────
const activeBrowserUseSessions = new Map(); // sessionId → { pid, startedAt }

// Hardcoded Supabase endpoints for browser-use agent
const BU_TASK_ENDPOINT = 'https://wlowwprkjdhvfecsxsvp.supabase.co/functions/v1/browser-agent-task';
const BU_LOG_ENDPOINT  = 'https://wlowwprkjdhvfecsxsvp.supabase.co/functions/v1/browser-agent-log';
const BU_MAX_STEPS     = 1000000; // effectively unlimited — timeout is the real constraint
const BU_TIMEOUT       = 36000; // 10 hours max

async function handleBrowserUse(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — provide auth_token in body or Authorization: Bearer header');
  }

  const {
    session_id: sessionId,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    agent_type: agentType = 'default',
    lead_import_page_turns: pageTurns = null,
    list: listName = null,
  } = body;
  const authToken = body.auth_token || (req.headers['authorization'] || '').replace('Bearer ', '').trim();

  if (!sessionId) return err(res, 400, 'session_id is required');
  if (!userPrompt) return err(res, 400, 'user_prompt is required');

  // Respond immediately — agent runs in background
  json(res, 200, {
    status: 'started',
    session_id: sessionId,
    message: 'Browser-use agent started.',
  });

  // Spawn agent in background
  (async () => {
    try {
      // ── Start MLX Lead_Collector profile with full error recovery ──────────
      const { startProfile } = await import('/data/multilogin/multilogin.js');
      // Lead_Collector_V2 profile — hardcoded ID for reliability
      const profileId = 'dc19bdae-14f0-44aa-949e-903ce82ef2fa';
      const folderId = process.env.MULTILOGIN_FOLDER_ID || '3d1d4dee-4839-49fc-a414-616b069c9fbf';

      // Get CDP URL — handles ALL states: not started, already running, agent disconnected
      let cdpUrl;
      const { stopProfile } = await import('/data/multilogin/multilogin.js');

      for (let attempt = 1; attempt <= 3; attempt++) {
        process.stderr.write(`[browser-use-api] Session ${sessionId}: startProfile attempt ${attempt}/3\n`);
        try {
          cdpUrl = await startProfile(profileId, folderId);
          break;
        } catch (startErr) {
          const msg = startErr.message || '';
          process.stderr.write(`[browser-use-api] Attempt ${attempt} failed: ${msg.slice(0, 150)}\n`);

          if (attempt === 1) {
            // Try cached CDP
            try {
              const cached = JSON.parse(readFileSync('/data/multilogin/open-profiles.json', 'utf8'))[profileId];
              if (cached?.cdpUrl) {
                // Verify it's actually reachable
                const testFetch = await fetch(cached.cdpUrl.replace('ws://', 'http://').replace(/\/devtools.*/, '/json/version'), { signal: AbortSignal.timeout(5000) }).catch(() => null);
                if (testFetch?.ok) {
                  cdpUrl = cached.cdpUrl;
                  process.stderr.write(`[browser-use-api] Using verified cached CDP: ${cdpUrl}\n`);
                  break;
                }
              }
            } catch {}
          }

          if (attempt === 2) {
            // Stop the profile completely and restart fresh
            process.stderr.write(`[browser-use-api] Stopping profile and restarting fresh...\n`);
            try {
              await stopProfile(profileId).catch(() => {});
              writeFileSync('/data/multilogin/open-profiles.json', '{}');
              await new Promise(r => setTimeout(r, 5000));
              cdpUrl = await startProfile(profileId, folderId);
              break;
            } catch (e2) {
              process.stderr.write(`[browser-use-api] Fresh restart failed: ${e2.message.slice(0, 100)}\n`);
            }
          }

          if (attempt === 3) {
            // Last resort: run recovery script + final attempt
            process.stderr.write(`[browser-use-api] Running MLX recovery...\n`);
            try {
              spawnSync('bash', ['/data/recover-mlx.sh'], { timeout: 75000, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch {}
            await new Promise(r => setTimeout(r, 10000));
            try {
              await stopProfile(profileId).catch(() => {});
              writeFileSync('/data/multilogin/open-profiles.json', '{}');
              await new Promise(r => setTimeout(r, 5000));
              cdpUrl = await startProfile(profileId, folderId);
              break;
            } catch (finalErr) {
              throw new Error(`All 3 attempts failed. Last: ${finalErr.message.slice(0, 150)}`);
            }
          }
        }
      }

      if (!cdpUrl) throw new Error('No CDP URL obtained');

      process.stderr.write(`[browser-use-api] Session ${sessionId}: CDP ${cdpUrl}\n`);
      activeBrowserUseSessions.set(sessionId, {
        startedAt: Date.now(), cdpUrl, authToken,
        pageTurns: pageTurns ? parseInt(pageTurns) : null,
        listName: listName || `import_${sessionId.slice(0, 8)}`,
      });

      // Pre-launch: open fresh tab → navigate → wait 15s → click broom → activate agent
      process.stderr.write(`[browser-use-api] Session ${sessionId}: Pre-launch — opening fresh Lemlist tab...\n`);
      try {
        const pwPkg = await import('/data/human-browser/node_modules/playwright-core/index.js');
        const pw = pwPkg.default || pwPkg;
        const preBrowser = await pw.chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
        const preCtx = preBrowser.contexts()[0] || await preBrowser.newContext();
        const prePage = await preCtx.newPage();

        // Navigate and wait for page to fully load
        // Tag the tab with session ID so browser-use and import can find THIS exact tab
        await prePage.goto(`https://app.lemlist.com/teams/tea_NqA4w3k43yBJK2NKw/people-database#session=${sessionId}`, {
          waitUntil: 'domcontentloaded', timeout: 60000,
        }).catch(() => {});
        await prePage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Page loaded. Waiting 15s to settle...\n`);
        await new Promise(r => setTimeout(r, 15000));

        // If page looks empty or error, refresh once
        const hasFilters = await prePage.evaluate(() => document.querySelectorAll('[data-filter-id]').length > 0).catch(() => false);
        if (!hasFilters) {
          process.stderr.write(`[browser-use-api] Session ${sessionId}: Page empty — refreshing...\n`);
          await prePage.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await prePage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 10000));
        }

        // Click broom to clear all filters
        const broomClicked = await prePage.evaluate(() => {
          const btn = document.querySelector('button:has(i.fa-broom-wide)') ||
                      document.querySelector('.filter-title-actions button:last-child');
          if (btn && btn.getBoundingClientRect().width > 0) { btn.click(); return true; }
          return false;
        }).catch(() => false);
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Broom clicked: ${broomClicked}. Filters cleared.\n`);
        await new Promise(r => setTimeout(r, 2000));

        // Close ALL tabs EXCEPT the session-tagged one — guarantees agent lands on the right page
        const allTabs = preCtx.pages();
        for (const tab of allTabs) {
          if (!tab.url().includes(`session=${sessionId}`)) {
            try { await tab.close(); } catch {}
          }
        }
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Closed other tabs. Remaining: ${preCtx.pages().length} tab(s)\n`);

        try { await preBrowser.close(); } catch {}
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Pre-launch complete. Activating agent...\n`);
      } catch (preErr) {
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Pre-launch error (non-fatal): ${preErr.message.slice(0, 150)}\n`);
      }

      const postLog = (event) => {
        try {
          const cbPath = `/tmp/bu-log-${sessionId}-${Date.now()}.json`;
          writeFileSync(cbPath, JSON.stringify({ session_id: sessionId, ...event }));
          const curlArgs = ['-s', '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-H', `Authorization: Bearer ${authToken}`,
            '-d', `@${cbPath}`, '--max-time', '30', BU_LOG_ENDPOINT];
          const proc = spawn('curl', curlArgs,
            { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
          proc.unref();
          setTimeout(() => { try { unlinkSync(cbPath); } catch {} }, 35000);
        } catch {}
      };

      const result = await runBrowserUseTask(userPrompt, cdpUrl, {
        maxSteps: BU_MAX_STEPS,
        timeout: BU_TIMEOUT,
        systemPromptText: systemPrompt || null,
        stepCallbackUrl: BU_LOG_ENDPOINT,
        sessionId,
        toolEndpoint: BU_TASK_ENDPOINT,
        toolSessionId: sessionId,
        toolAuthToken: authToken,
      });

      const sessionConfig = activeBrowserUseSessions.get(sessionId);
      activeBrowserUseSessions.delete(sessionId);
      process.stderr.write(`[browser-use-api] Session ${sessionId}: ${result.success ? 'SUCCESS' : 'FAILED'} (${result.steps} steps, ${result.duration_ms}ms)\n`);

      postLog({
        event: 'session_complete',
        success: result.success,
        result: result.result || '',
        total_steps: result.steps,
        duration_ms: result.duration_ms,
        errors: result.errors || [],
        timestamp: new Date().toISOString(),
      });

      // Auto-trigger lead import if agent succeeded and pageTurns is configured
      if (result.success && sessionConfig?.pageTurns) {
        const importListName = sessionConfig.listName;
        const leadCount = sessionConfig.pageTurns * 100;
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Auto-starting lead import: "${importListName}", ${leadCount} leads (${sessionConfig.pageTurns} pages)\n`);

        const importPayload = {
          list_name: importListName,
          lead_count: leadCount,
          filters: [],
          callback_url: BU_LOG_ENDPOINT,
          callback_metadata: { execution_id: sessionId, session_id: sessionId },
          auth_token: sessionConfig.authToken,
        };
        const importPath = `/tmp/lemlist-import-${sessionId}.json`;
        writeFileSync(importPath, JSON.stringify(importPayload));

        const importLogPath = `/tmp/lemlist-import-${sessionId}.log`;
        const { openSync } = await import('fs');
        const importLogFd = openSync(importLogPath, 'a');
        spawn(process.execPath, [
          '/data/lemlist/lemlist-collect.js',
          importPath,
          BU_LOG_ENDPOINT,
          sessionId,
        ], { detached: true, stdio: ['ignore', importLogFd, importLogFd], env: process.env }).unref();
        process.stderr.write(`[browser-use-api] Import log: ${importLogPath}\n`);
      } else if (result.success) {
        process.stderr.write(`[browser-use-api] Session ${sessionId}: Agent succeeded but import NOT auto-started (pageTurns=${sessionConfig?.pageTurns}, result="${(result.result || '').slice(0, 50)}")\n`);
      }

    } catch (e) {
      process.stderr.write(`[browser-use-api] Session ${sessionId} ERROR: ${e.message}\n`);
      try {
        const errBody = JSON.stringify({
          session_id: sessionId,
          event: 'session_complete',
          success: false,
          error: e.message,
          timestamp: new Date().toISOString(),
        });
        const proc = spawn('curl', ['-s', '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-H', `Authorization: Bearer ${authToken}`,
          '-d', errBody, '--max-time', '30', BU_LOG_ENDPOINT],
          { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
        proc.unref();
      } catch {}
    }
  })();
}

// ── Browser-Use kill endpoint ────────────────────────────────────────────────
async function handleBrowserUseKill(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized');
  }

  const sessionId = body.session_id;
  if (!sessionId) return err(res, 400, 'session_id is required');

  // Kill any Python runner processes for this session
  try {
    spawnSync('pkill', ['-f', `--session-id ${sessionId}`], { timeout: 5000 });
  } catch {}

  const wasActive = activeBrowserUseSessions.has(sessionId);
  activeBrowserUseSessions.delete(sessionId);

  process.stderr.write(`[browser-use-api] Kill request for session ${sessionId} (was active: ${wasActive})\n`);

  json(res, 200, {
    status: 'killed',
    session_id: sessionId,
    was_active: wasActive,
  });
}

// ── Request router ────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // ── CORS: restrict to known origins only ─────────────────────────────────────
  const origin = req.headers['origin'] || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin === o || origin.startsWith(o));
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  // No wildcard Access-Control-Allow-Origin — browser requests from unknown origins
  // will be blocked by the browser's CORS enforcement.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────────
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (!checkRateLimit(clientIp)) {
    res.setHeader('Retry-After', '60');
    return err(res, 429, 'Too many requests — slow down');
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Auth check (skip health and /api/v1/ routes — those do their own auth)
  if (req.url !== '/api/health' && !path.startsWith('/api/v1/') && !checkAuth(req)) {
    return err(res, 401, 'Unauthorized — provide: Authorization: Bearer <TASK_API_TOKEN>');
  }

  try {
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - startTime) / 1000) });
    }

    if (req.method === 'POST' && path === '/api/session') {
      return await handleCreateSession(req, res);
    }

    if (req.method === 'GET' && path.startsWith('/api/session/')) {
      const sessionId = path.replace('/api/session/', '').trim();
      return await handleGetSession(req, res, sessionId);
    }

    if (req.method === 'POST' && path === '/api/task') {
      return await handleDispatchTask(req, res);
    }

    if (req.method === 'GET' && path === '/api/clients') {
      return await handleListClients(req, res);
    }

    if (req.method === 'POST' && path === '/api/clients') {
      return await handleCreateClient(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/working-session') {
      return await handleMarinerWorkingSession(req, res);
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/working-session/')) {
      const sessionId = path.replace('/api/v1/working-session/', '').trim();
      return await handleMarinerGetSession(req, res, sessionId);
    }

    if (req.method === 'POST' && path === '/api/v1/provision-profile') {
      return await handleProvisionProfile(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/generate-post') {
      return await handleGeneratePost(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/screenshot') {
      return await handleScreenshot(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/lemlist/filter-leads') {
      return await handleLemlistFilterLeads(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/lemlist/collect-leads') {
      return await handleLemlistCollectLeads(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/browser-use') {
      return await handleBrowserUse(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/browser-use/kill') {
      return await handleBrowserUseKill(req, res);
    }

    err(res, 404, `Route not found: ${req.method} ${path}`);
  } catch (e) {
    process.stderr.write(`[task-api] Unhandled error: ${e.message}\n`);
    err(res, 500, `Internal error: ${e.message}`);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`[task-api] Listening on port ${PORT}\n`);
  process.stderr.write(`[task-api] Auth token: ${AUTH_TOKEN.slice(0, 8)}...\n`);
  process.stderr.write(`[task-api] Endpoints: POST /api/session, GET /api/session/:id, POST /api/task, GET|POST /api/clients, POST /api/v1/screenshot\n`);
});

server.on('error', e => {
  process.stderr.write(`[task-api] Server error: ${e.message}\n`);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
