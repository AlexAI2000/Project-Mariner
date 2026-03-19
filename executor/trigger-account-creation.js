#!/usr/bin/env node
// trigger-account-creation.js — Spawns an sm-linkedin worker agent directly (detached background).
// Worker selection is round-robin; no LLM hop required for routing.
//
// Usage: node trigger-account-creation.js <clientId> <platform> <clientName> <briefingJson> <webhookUrl> [executionId]
// Output: JSON { success, pid, worker, sessionId, logFile } to stdout (returns immediately)
// Exit 0: worker triggered  Exit 1: error

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { openSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

const [, , clientId, platform, clientName, briefingRaw, webhookUrl, executionId = null] = process.argv;

if (!clientId || !platform || !clientName || !briefingRaw || !webhookUrl) {
  console.error('Usage: node trigger-account-creation.js <clientId> <platform> <clientName> <briefingJson> <webhookUrl> [executionId]');
  process.exit(1);
}

let briefing;
try {
  briefing = JSON.parse(briefingRaw);
} catch {
  briefing = { oneLineSummary: briefingRaw };
}

// ── Worker selection (round-robin by platform) ────────────────────────────────

const WORKERS = {
  linkedin:  ['sm-linkedin-1', 'sm-linkedin-2', 'sm-linkedin-3', 'sm-linkedin-4', 'sm-linkedin-5'],
  instagram: ['sm-instagram'],
  twitter:   ['sm-twitter'],
  facebook:  ['sm-facebook'],
};

const WORKER_COUNTER_FILE = `/tmp/worker-counter-${platform}.json`;

function pickWorker(p) {
  const pool = WORKERS[p] || WORKERS.linkedin;
  let counter = 0;
  try {
    counter = JSON.parse(readFileSync(WORKER_COUNTER_FILE, 'utf8')).counter || 0;
  } catch { /* first run */ }
  const worker = pool[counter % pool.length];
  writeFileSync(WORKER_COUNTER_FILE, JSON.stringify({ counter: counter + 1 }));
  return worker;
}

const workerName = pickWorker(platform.toLowerCase());

// ── Session + payload ─────────────────────────────────────────────────────────

const sessionId = `mariner-${clientId}-${randomUUID().slice(0, 8)}`;
const logFile = `/tmp/${workerName}-${sessionId}.log`;
const profileDetails = JSON.stringify(briefing, null, 2);

const successPayload = JSON.stringify({
  type: 'account_created',
  execution_id: executionId,
  session_id: sessionId,
  account_id: clientId,
  client_name: clientName,
  platform,
  status: 'complete',
});

const failurePayload = JSON.stringify({
  type: 'account_created',
  execution_id: executionId,
  session_id: sessionId,
  account_id: clientId,
  client_name: clientName,
  platform,
  status: 'failed',
  error: '<reason>',
});

// Worker task message — full context for the browser operator agent
const message = [
  `WORKER_TASK [${clientId}/${platform}/account_creation]: Create full ${platform} account for ${clientName}.`,
  ``,
  `clientId: ${clientId}`,
  `clientName: ${clientName}`,
  `platform: ${platform}`,
  `executionId: ${executionId || 'none'}`,
  ``,
  `Profile details (JSON):`,
  profileDetails,
  ``,
  `SUCCESS CALLBACK — execute this curl command when account is fully created:`,
  `curl -s -X POST -H "Content-Type: application/json" -d '${successPayload}' '${webhookUrl}'`,
  ``,
  `FAILURE CALLBACK — execute this curl command if creation fails:`,
  `curl -s -X POST -H "Content-Type: application/json" -d '${failurePayload.replace('<reason>', 'actual error')}' '${webhookUrl}'`,
].join('\n');

// ── Clear worker session state ────────────────────────────────────────────────

const WORKER_SESSIONS = `/data/.openclaw/agents/${workerName}/sessions/sessions.json`;
try {
  if (existsSync(WORKER_SESSIONS)) {
    const s = JSON.parse(readFileSync(WORKER_SESSIONS, 'utf8'));
    delete s[`agent:${workerName}:main`];
    writeFileSync(WORKER_SESSIONS, JSON.stringify(s, null, 2));
  }
} catch { /* non-fatal */ }

// ── Spawn worker agent detached ───────────────────────────────────────────────

mkdirSync('/tmp', { recursive: true });
const logFd = openSync(logFile, 'a');
const child = spawn('openclaw', [
  'agent', '--local', '--agent', workerName,
  '--session-id', sessionId,
  '--message', message,
], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env },
});

child.unref();

const pid = child.pid;
console.log(JSON.stringify({
  success: true,
  pid,
  worker: workerName,
  logFile,
  sessionId,
  message: `Worker ${workerName} triggered in background (PID ${pid}). Account creation in progress for ${clientId}.`,
}));
