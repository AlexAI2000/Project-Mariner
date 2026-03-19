#!/usr/bin/env node
// spawn-team.js — Mariner Apex Team Spawner
//
// Creates the session JSONL with the full task list, then spawns the complete
// 3-agent + 3-watchdog team for a given session:
//
//   1. Mariner Apex Pilot   (OpenClaw AI agent)
//   2. Humanizer Daemon     (Node.js daemon process)
//   3. Assistant Daemon     (Node.js daemon process)
//   4. Watchdog: Pilot      (bash infinite loop)
//   5. Watchdog: Humanizer  (bash infinite loop)
//   6. Watchdog: Assistant  (bash infinite loop)
//
// Usage (called by trigger-working-session.js):
//   node spawn-team.js <sessionId> <pilotAgentName> <accountId> <platform>
//                      <clientName> <tasksJson> <callbackUrl> <executionId>
//
// Returns JSON to stdout: { success, sessionId, pids: { pilot, humanizer, assistant,
//                           watchdogPilot, watchdogHumanizer, watchdogAssistant } }

import { spawn, execFileSync } from 'child_process';
import { openSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

const SESSIONS_DIR = '/data/sessions';

const [, , sessionId, pilotAgentName, accountId, platform, clientName, tasksRaw, callbackUrl, executionId] = process.argv;

if (!sessionId || !pilotAgentName || !accountId || !tasksRaw) {
  console.error('Missing required args');
  process.exit(1);
}

let tasks;
try { tasks = JSON.parse(tasksRaw); }
catch { console.error('Invalid tasks JSON'); process.exit(1); }

// ── 1. Create JSONL session file with full task list ─────────────────────────

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync('/tmp', { recursive: true });

const sessionFile = join(SESSIONS_DIR, `${sessionId}.jsonl`);

function appendLine(obj) {
  appendFileSync(sessionFile, JSON.stringify({ ts: Date.now(), ...obj }) + '\n', 'utf8');
}

// Only initialize if the file doesn't already exist (crash recovery case)
if (!existsSync(sessionFile)) {
  appendLine({
    type: 'session_start',
    sessionId,
    accountId,
    platform,
    clientName,
    executionId,
    tasks: tasks.map((t, i) => ({
      index: i + 1,
      task_type: t.task_type,
      details: t.details || null,
      status: 'pending',
    })),
  });
}

// ── 2. Build PID file paths ───────────────────────────────────────────────────

const pilotPidFile     = `/tmp/mariner-pilot-${sessionId}.pid`;
const humanizerPidFile = `/tmp/mariner-humanizer-${sessionId}.pid`;
const assistantPidFile = `/tmp/mariner-assistant-${sessionId}.pid`;

// ── 3. Build task list message for the Pilot ─────────────────────────────────

const taskList = tasks.map((t, i) => {
  const details = t.details ? ` — details: ${JSON.stringify(t.details)}` : '';
  return `${i + 1}. ${t.task_type}${details}`;
}).join('\n');

const successPayload = JSON.stringify({
  execution_id: executionId,
  session_id: sessionId,
  account_id: accountId,
  client_name: clientName,
  platform,
  status: 'completed',
  tasks_completed: tasks.length,
  tasks_total: tasks.length,
  message: 'Working session completed successfully',
});

const failurePayload = JSON.stringify({
  execution_id: executionId,
  session_id: sessionId,
  account_id: accountId,
  client_name: clientName,
  platform,
  status: 'failed',
  tasks_completed: 0,
  tasks_total: tasks.length,
  message: 'Working session failed',
  error: '<reason>',
});

const pilotMessage = [
  `MARINER_APEX_TASK [${accountId}/${platform}/working_session]: Execute ${platform} working session for ${clientName}.`,
  ``,
  `SESSION_ID: ${sessionId}`,
  `ACCOUNT_ID: ${accountId}`,
  `CLIENT_NAME: ${clientName}`,
  `PLATFORM: ${platform}`,
  `EXECUTION_ID: ${executionId}`,
  `JSONL_SESSION_FILE: ${sessionFile}`,
  ``,
  `COMPLETE TASK LIST (execute ALL in sequence):`,
  taskList,
  ``,
  `SUCCESS CALLBACK — execute when ALL tasks complete:`,
  `curl -s -X POST -H 'Content-Type: application/json' -d '${successPayload}' '${callbackUrl}'`,
  ``,
  `FAILURE CALLBACK — execute if session fails:`,
  `curl -s -X POST -H 'Content-Type: application/json' -d '${failurePayload.replace('<reason>', '<actual error reason>')}' '${callbackUrl}'`,
].join('\n');

// ── 4. Helper: spawn detached process ────────────────────────────────────────

function spawnDetached(cmd, args, logFile, pidFile) {
  const logFd = openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  if (pidFile) writeFileSync(pidFile, String(child.pid), 'utf8');
  return child.pid;
}

// ── 5. Clear pilot session state (fresh context per run) ─────────────────────
// (Keep existing crash-recovery logic for the pilot agent session)
try {
  const sessionsPath = `/data/.openclaw/agents/${pilotAgentName}/sessions/sessions.json`;
  const { readFileSync: rfs, existsSync: efs, writeFileSync: wfs } = await import('fs');
  if (efs(sessionsPath)) {
    const s = JSON.parse(rfs(sessionsPath, 'utf8'));
    delete s[`agent:${pilotAgentName}:main`];
    wfs(sessionsPath, JSON.stringify(s, null, 2));
  }
} catch { /* non-fatal */ }

// ── 6. Spawn Humanizer Daemon ─────────────────────────────────────────────────

const humanizerLog = `/tmp/humanizer-${sessionId}.log`;
const humanizerPid = spawnDetached(
  'node',
  ['/data/mariner/humanizer-daemon.js', sessionId, `mariner-humanizer`, humanizerPidFile],
  humanizerLog,
  humanizerPidFile,
);

// ── 7. Spawn Assistant Daemon ─────────────────────────────────────────────────

const assistantLog = `/tmp/assistant-${sessionId}.log`;
const assistantPid = spawnDetached(
  'node',
  ['/data/mariner/assistant-daemon.js', sessionId, `mariner-assistant`, assistantPidFile],
  assistantLog,
  assistantPidFile,
);

// ── 8. Spawn Pilot (OpenClaw AI agent) ───────────────────────────────────────

const pilotLog = `/tmp/${pilotAgentName}-${sessionId}.log`;
const pilotLogFd = openSync(pilotLog, 'a');
const pilotChild = spawn('openclaw', [
  'agent', '--local', '--agent', pilotAgentName,
  '--session-id', sessionId,
  '--message', pilotMessage,
], {
  detached: true,
  stdio: ['ignore', pilotLogFd, pilotLogFd],
  env: { ...process.env },
});
pilotChild.unref();
const pilotPid = pilotChild.pid;
writeFileSync(pilotPidFile, String(pilotPid), 'utf8');

// ── 9. Spawn 3 Watchdogs (each monitors one agent) ───────────────────────────

// Watchdog: Pilot — restarts the openclaw agent if it dies before session_complete
const watchdogPilotLog = `/tmp/watchdog-pilot-${sessionId}.log`;
const watchdogPilotPid = spawnDetached('bash', [
  '/data/mariner/watchdog.sh',
  sessionId, 'pilot', pilotPidFile,
  // restart command: re-spawn the pilot agent
  'openclaw', 'agent', '--local', '--agent', pilotAgentName,
  '--session-id', sessionId,
  '--message', pilotMessage,
], watchdogPilotLog);

// Watchdog: Humanizer — restarts the humanizer daemon
const watchdogHumanizerLog = `/tmp/watchdog-humanizer-${sessionId}.log`;
const watchdogHumanizerPid = spawnDetached('bash', [
  '/data/mariner/watchdog.sh',
  sessionId, 'humanizer', humanizerPidFile,
  'node', '/data/mariner/humanizer-daemon.js', sessionId, 'mariner-humanizer', humanizerPidFile,
], watchdogHumanizerLog);

// Watchdog: Assistant — restarts the assistant daemon
const watchdogAssistantLog = `/tmp/watchdog-assistant-${sessionId}.log`;
const watchdogAssistantPid = spawnDetached('bash', [
  '/data/mariner/watchdog.sh',
  sessionId, 'assistant', assistantPidFile,
  'node', '/data/mariner/assistant-daemon.js', sessionId, 'mariner-assistant', assistantPidFile,
], watchdogAssistantLog);

// ── 10. Output result ─────────────────────────────────────────────────────────

console.log(JSON.stringify({
  success: true,
  sessionId,
  pilot: pilotAgentName,
  pids: {
    pilot: pilotPid,
    humanizer: humanizerPid,
    assistant: assistantPid,
    watchdogPilot: watchdogPilotPid,
    watchdogHumanizer: watchdogHumanizerPid,
    watchdogAssistant: watchdogAssistantPid,
  },
  logs: {
    pilot: pilotLog,
    humanizer: humanizerLog,
    assistant: assistantLog,
  },
  sessionFile,
  message: `Mariner Apex team launched for ${accountId} on ${platform}. Pilot: ${pilotAgentName} (PID ${pilotPid}).`,
}));
