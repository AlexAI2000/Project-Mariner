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
//   Body: { clientId, platform, clientName?, tasks: [{id, label, steps},...] }
//   Creates a background session. Returns { sessionId, status, isNew }
//   isNew=true means MultiLogin X profile was auto-created for this client.
//
// GET /api/session/:id
//   Returns full session state: { sessionId, status, tasks, result, clientContext }
//
// POST /api/task
//   Body: { clientId, platform, steps: [...] }
//   Synchronous single-task dispatch. Waits up to 5 min for result.
//   Returns { success, results, error }
//
// GET /api/clients
//   Returns list of all registered clients with their platforms.
//
// POST /api/clients
//   Body: { clientId, name, proxy?, phone? }
//   Ensures a client entry exists. Returns { clientId, isNew }
//
// GET /api/health
//   Returns { ok: true, uptime }
//
// POST /api/v1/working-session   (Lovable/Mariner working session bridge)
//   Body: { session_id?, client_name, account_id, platform, working_session: { tasks: [{task_type, details?}] },
//           timeout?, auth_token, callback_url, callback_metadata: { execution_id } }
//   Dispatches all task types to the director agent. Fires callback_url on completion with execution_id.
//   Returns { session_id, account_id, execution_id, status, message }
//
// GET /api/v1/working-session/:id
//   Returns session state in Lovable format.
//
// POST /api/v1/account-creation  (Lovable account creation bridge)
//   Body: { client_name, account_id, platform, account_creation: { tasks: {...}, briefing: "..." },
//           timeout?, auth_token, callback_url, callback_metadata: { execution_id } }
//   Triggers full account creation via director agent. Fires callback_url on completion.
//   Returns { session_id, account_id, execution_id, status, message }
//
// GET /api/v1/account-creation/:id
//   Returns session state in Lovable format.
//
// POST /api/v1/provision-profile  (MLX profile-only provisioning, no agent)
//   Body: { account_id, client_name?, platform?, auth_token, callback_url, callback_metadata: { execution_id } }
//   Creates proxy + MLX browser profile. Does NOT launch an AI agent or open a browser session.
//   Fires callback_url with { execution_id, account_id, platform, status, mlProfileId, folderId, isNew }.
//   Returns { session_id, account_id, execution_id, status, message }
//
// ──────────────────────────────────────────────────────────────────────────────

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';

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
    platform: body.platform || null,
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
    platform: session.platform || null,
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
    platform: body.platform || null,
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
  const platform = body.platform || 'linkedin';
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

  const sessionTasks = [
    {
      id: 'ensure-client',
      type: 'bash',
      label: `Ensure client entry for ${accountId}`,
      command: `node /data/clients/client-manager.js ensure '${safeAccountId}' '${safeClientName}'`,
    },
    {
      id: 'execute-working-session',
      type: 'bash',
      label: `Execute ${platform} working session (${incomingTasks.length} task${incomingTasks.length !== 1 ? 's' : ''})`,
      command:
        `node /data/executor/trigger-working-session.js ` +
        `'${safeAccountId}' '${platform}' '${safeClientName}' ` +
        `${JSON.stringify(tasksJson)} ` +
        `${JSON.stringify(callbackUrl)} ` +
        `${JSON.stringify(executionId)}`,
    },
  ];

  const plan = {
    clientId: accountId,
    clientName,
    platform,
    callbackUrl,
    callbackMetadata,
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
      message: `Working session started. Director will execute ${incomingTasks.length} ${platform} task(s) for ${clientName}.`,
    });
  } catch (e) {
    return err(res, 500, `Failed to launch working session: ${e.message}`);
  }
}

// POST /api/v1/account-creation
// Accepts account creation payload from Lovable. Triggers full account setup via director agent.
// Fires callback_url with execution_id on completion.
async function handleAccountCreation(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — invalid auth_token');
  }

  const accountId = body.account_id;
  const clientName = body.client_name || accountId;
  const platform = body.platform || 'linkedin';
  const callbackUrl = body.callback_url || MARINER_WEBHOOK_URL;
  const callbackMetadata = body.callback_metadata || {};
  const executionId = callbackMetadata.execution_id || randomUUID();
  const accountCreation = body.account_creation || {};
  const tasks = accountCreation.tasks || {};
  const briefingText = accountCreation.briefing || '';

  if (!accountId) return err(res, 400, 'account_id is required');

  // SSRF protection: validate callback_url points to an allowed external HTTPS endpoint
  if (body.callback_url && !isAllowedCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be an HTTPS URL pointing to an allowed domain (supabase.co or lovable.app)');
  }

  const briefingObj = {
    name: tasks.create_account_name || clientName,
    platform,
    oneLineSummary: briefingText || tasks.create_headline || '',
    ...(tasks.create_headline && { headline: tasks.create_headline }),
    ...(tasks.create_biography && { bio: tasks.create_biography }),
    ...(tasks.create_working_history && { workHistory: tasks.create_working_history }),
    ...(tasks.create_skills && { skills: tasks.create_skills }),
  };
  const briefingJson = JSON.stringify(briefingObj);

  const safeAccountId = accountId.replace(/'/g, '');
  const safeClientName = clientName.replace(/'/g, '').replace(/"/g, '');

  const sessionTasks = [
    {
      id: 'init-client',
      type: 'bash',
      label: 'Create proxy + MLX profile & save briefing',
      // 'resolve' creates client entry, proxy, and MLX profile in the correct order.
      // It is idempotent — safe to retry if the session is restarted.
      command:
        `node /data/clients/client-manager.js resolve '${safeAccountId}' '${platform}' '${safeClientName}' && ` +
        `node /data/content-generators/save-briefing.js '${safeAccountId}' ${JSON.stringify(briefingJson)}`,
    },
    {
      id: 'trigger-account-creation',
      type: 'bash',
      label: `Trigger ${platform} account creation via director`,
      command:
        `node /data/executor/trigger-account-creation.js ` +
        `'${safeAccountId}' '${platform}' '${safeClientName}' ` +
        `${JSON.stringify(briefingJson)} ` +
        `${JSON.stringify(callbackUrl)} ` +
        `${JSON.stringify(executionId)}`,
    },
  ];

  const plan = {
    clientId: accountId,
    clientName,
    platform,
    callbackUrl,
    callbackMetadata,
    tasks: sessionTasks,
  };

  try {
    const launched = launchSession(plan);
    return json(res, 202, {
      session_id: launched.sessionId,
      account_id: accountId,
      execution_id: executionId,
      status: 'starting',
      message: `Account creation started for ${clientName} on ${platform}. Director agent will handle full setup.`,
    });
  } catch (e) {
    return err(res, 500, `Failed to launch account creation: ${e.message}`);
  }
}

// POST /api/v1/provision-profile
// Creates proxy + MLX browser profile for an account. Does NOT launch an AI agent.
// Fires callback_url with { execution_id, account_id, platform, status, mlProfileId, folderId, isNew }.
async function handleProvisionProfile(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return err(res, 400, e.message); }

  if (!checkMarinerAuth(req, body)) {
    return err(res, 401, 'Unauthorized — invalid auth_token');
  }

  const accountId = body.account_id;
  const clientName = body.client_name || accountId;
  const platform = body.platform || 'linkedin';
  const callbackUrl = body.callback_url || MARINER_WEBHOOK_URL;
  const callbackMetadata = body.callback_metadata || {};
  const executionId = callbackMetadata.execution_id || randomUUID();

  if (!accountId) return err(res, 400, 'account_id is required');

  if (body.callback_url && !isAllowedCallbackUrl(callbackUrl)) {
    return err(res, 400, 'callback_url must be HTTPS on an allowed domain (supabase.co or lovable.app)');
  }

  const safeAccountId = accountId.replace(/'/g, '');
  const safeClientName = clientName.replace(/'/g, '').replace(/"/g, '');

  const plan = {
    clientId: accountId,
    clientName,
    platform,
    tasks: [{
      id: 'provision-profile',
      type: 'bash',
      label: `Create proxy + MLX profile for ${clientName} on ${platform}`,
      command:
        `node /data/executor/provision-profile.js ` +
        `'${safeAccountId}' '${platform}' '${safeClientName}' ` +
        `${JSON.stringify(callbackUrl)} ` +
        `${JSON.stringify(executionId)}`,
    }],
  };

  try {
    const launched = launchSession(plan);
    return json(res, 202, {
      session_id: launched.sessionId,
      account_id: accountId,
      execution_id: executionId,
      status: 'starting',
      message: `Profile provisioning started for ${clientName} on ${platform}.`,
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
    platform: null,
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
    platform: session.platform,
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

    if (req.method === 'POST' && path === '/api/v1/account-creation') {
      return await handleAccountCreation(req, res);
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/account-creation/')) {
      const sessionId = path.replace('/api/v1/account-creation/', '').trim();
      return await handleMarinerGetSession(req, res, sessionId);
    }

    if (req.method === 'POST' && path === '/api/v1/provision-profile') {
      return await handleProvisionProfile(req, res);
    }

    if (req.method === 'POST' && path === '/api/v1/generate-post') {
      return await handleGeneratePost(req, res);
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
  process.stderr.write(`[task-api] Endpoints: POST /api/session, GET /api/session/:id, POST /api/task, GET|POST /api/clients\n`);
});

server.on('error', e => {
  process.stderr.write(`[task-api] Server error: ${e.message}\n`);
  process.exit(1);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
