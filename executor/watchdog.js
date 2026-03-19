#!/usr/bin/env node
// watchdog.js — CLI-aware session watchdog. Monitors JSONL stream for freezes.
// Called by OpenClaw cron every 30 seconds per active session.
// Usage: node /data/executor/watchdog.js <sessionId>
//
// Behavior:
//   - done/error:  cancels cron, outputs completion summary
//   - healthy:     JSONL updated < 45s ago → HEARTBEAT_OK, exit 0
//   - frozen:      no JSONL write for 45s → kill agent, restart from last checkpoint
//   - no daemon:   restarts daemon first, then restarts agent

import { readFileSync, writeFileSync, existsSync, statSync, openSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = '/data/sessions';
const EXECUTOR = join(__dir, 'executor.js');
const START_SESSION = '/data/browser-cli/start-session.js';

// Thresholds
const FREEZE_THRESHOLD_MS  = 45 * 1000;   // 45s — no JSONL write = frozen
const LEGACY_STALE_MS      = 8 * 60 * 1000; // 8m — fallback for non-JSONL sessions

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('Usage: node watchdog.js <sessionId>');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function cancelCron(cronName) {
  if (!cronName) return;
  try {
    execSync(`openclaw cron remove --name "${cronName}"`, { stdio: 'pipe', timeout: 10000 });
  } catch (e) {
    process.stderr.write(`Warning: cron removal failed: ${e.message}\n`);
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function killPid(pid, signal = 'SIGTERM') {
  if (!pid || !isPidAlive(pid)) return;
  try { process.kill(pid, signal); } catch {}
}

function formatSummary(session) {
  const lines = (session.tasks || []).map(t => {
    const icon = t.status === 'done' ? '[OK]' : t.status === 'skipped' ? '[SKIP]' : '[FAIL]';
    const detail = t.result?.summary || t.result?.error || t.status;
    return `${icon} ${t.label}: ${detail}`;
  });
  return lines.join('\n');
}

// ── JSONL utilities ────────────────────────────────────────────────────────────

function getJsonlPath(sid) {
  return join(SESSIONS_DIR, `${sid}.jsonl`);
}

function getJsonlMtime(sid) {
  const path = getJsonlPath(sid);
  if (!existsSync(path)) return null;
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function readLastCheckpoint(sid) {
  const path = getJsonlPath(sid);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'checkpoint') return obj;
      } catch {}
    }
    return null;
  } catch { return null; }
}

function readSessionStart(sid) {
  const path = getJsonlPath(sid);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'session_start') return obj;
      } catch {}
    }
    return null;
  } catch { return null; }
}

// ── Legacy session.json support ────────────────────────────────────────────────

function readLegacySession(sid) {
  const path = join(SESSIONS_DIR, `${sid}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// ── Daemon health check ────────────────────────────────────────────────────────

function isDaemonAlive(sid) {
  const pidPath = `/tmp/browser-cli-daemon-${sid}.pid`;
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf8'));
    return isPidAlive(pid);
  } catch { return false; }
}

function restartDaemon(sid, accountId, platform) {
  const child = spawn(process.execPath, [
    START_SESSION,
    '--session', sid,
    '--account', accountId || 'unknown',
    '--platform', platform || 'linkedin',
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

// ── Agent restart ──────────────────────────────────────────────────────────────

function buildResumeMessage(sid, checkpoint, sessionStart) {
  const completed = (checkpoint?.completedTasks || []).join(', ') || 'none';
  const pending = (checkpoint?.pendingTasks || []).join(', ') || 'unknown';
  const tabs = (checkpoint?.tabState || []).map(t => `  ${t.tabId}: ${t.url}`).join('\n') || '  (none)';
  const accountId = sessionStart?.accountId || 'unknown';
  const platform = sessionStart?.platform || 'linkedin';

  return [
    `RESUME_CHECKPOINT [${sid}]:`,
    ``,
    `Session was interrupted. Resume from last checkpoint.`,
    `accountId: ${accountId}`,
    `platform: ${platform}`,
    ``,
    `COMPLETED tasks (do NOT repeat these):`,
    completed,
    ``,
    `PENDING tasks (continue from here):`,
    pending,
    ``,
    `Browser daemon status: ${isDaemonAlive(sid) ? 'ALIVE — tabs still open' : 'RESTARTING — wait 10s for daemon, then start-session'}`,
    `Last known tabs:`,
    tabs,
    ``,
    `Instructions:`,
    `1. Check if daemon is alive: node /data/browser-cli/exec.js status --session ${sid}`,
    `2. If daemon not responding, run: node /data/browser-cli/start-session.js --session ${sid} --account ${accountId} --platform ${platform}`,
    `3. Continue executing PENDING tasks from where you left off.`,
    `4. Do NOT restart completed tasks.`,
    `5. Call SUCCESS CALLBACK when all tasks are done.`,
  ].join('\n');
}

function findWorkerForSession(sid) {
  // Look for running openclaw agent processes with this session ID
  try {
    const result = execSync(`pgrep -a -f "openclaw agent" 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
    const lines = result.trim().split('\n').filter(l => l.includes(sid));
    if (lines.length > 0) {
      // Extract agent name from command line
      const match = lines[0].match(/--agent\s+(\S+)/);
      return match ? match[1] : null;
    }
  } catch {}
  return null;
}

function restartAgent(sid, workerName, resumeMessage) {
  // Clear worker session state so agent starts fresh context
  const workerSessionsPath = `/data/.openclaw/agents/${workerName}/sessions/sessions.json`;
  if (existsSync(workerSessionsPath)) {
    try {
      const s = JSON.parse(readFileSync(workerSessionsPath, 'utf8'));
      delete s[`agent:${workerName}:main`];
      writeFileSync(workerSessionsPath, JSON.stringify(s, null, 2));
    } catch {}
  }

  const logFile = `/tmp/${workerName}-${sid}-resume.log`;
  mkdirSync('/tmp', { recursive: true });
  const logFd = openSync(logFile, 'a');

  const child = spawn('openclaw', [
    'agent', '--local', '--agent', workerName,
    '--session-id', sid,
    '--message', resumeMessage,
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  return { pid: child.pid, logFile };
}

// ── Main logic ─────────────────────────────────────────────────────────────────

async function main() {
  // ── Phase 1: Check legacy session.json for done/error ─────────────────────
  const legacy = readLegacySession(sessionId);

  if (legacy && (legacy.status === 'done' || legacy.status === 'error')) {
    cancelCron(legacy.watchdogCronName);
    const summary = formatSummary(legacy);
    const status = legacy.status === 'done' ? 'COMPLETE' : 'ERROR';
    console.log(
      `WATCHDOG_${status}: Session ${sessionId} finished.\n\n${summary}\n\n` +
      `Relay this result to Olaf. Cron "${legacy.watchdogCronName}" cancelled.`
    );
    process.exit(0);
  }

  // ── Phase 2: Check for .completed marker file ──────────────────────────────
  const completedFile = join(SESSIONS_DIR, `${sessionId}.json.completed`);
  if (existsSync(completedFile)) {
    cancelCron(legacy?.watchdogCronName);
    const msg = readFileSync(completedFile, 'utf8');
    console.log(`WATCHDOG_COMPLETE: ${msg}\nRelay this to Olaf.`);
    process.exit(0);
  }

  // ── Phase 3: JSONL-based health check (new system) ────────────────────────
  const jsonlPath = getJsonlPath(sessionId);

  if (existsSync(jsonlPath)) {
    const mtime = getJsonlMtime(sessionId);
    const age = Date.now() - (mtime || 0);

    if (age < FREEZE_THRESHOLD_MS) {
      // HEALTHY
      const checkpoint = readLastCheckpoint(sessionId);
      const completed = checkpoint?.completedTasks?.length || 0;
      const pending = checkpoint?.pendingTasks?.length || '?';
      const daemonAlive = isDaemonAlive(sessionId) ? 'daemon:OK' : 'daemon:DOWN';
      process.stderr.write(
        `HEARTBEAT_OK: session=${sessionId} last_write=${Math.round(age / 1000)}s ago ` +
        `completed=${completed} pending=${pending} ${daemonAlive}\n`
      );
      process.exit(0);
    }

    // FROZEN — JSONL hasn't been written for 45s+
    const checkpoint = readLastCheckpoint(sessionId);
    const sessionStart = readSessionStart(sessionId);
    const accountId = sessionStart?.accountId;
    const platform = sessionStart?.platform;

    process.stderr.write(
      `WATCHDOG_FREEZE: session=${sessionId} frozen for ${Math.round(age / 1000)}s. ` +
      `checkpoint=${checkpoint ? `completed=${checkpoint.completedTasks?.length}` : 'none'}\n`
    );

    // Kill current agent process if any
    const workerName = findWorkerForSession(sessionId);
    if (workerName) {
      try {
        const result = execSync(`pgrep -f "${sessionId}" 2>/dev/null || true`, { encoding: 'utf8' });
        const pids = result.trim().split('\n').filter(Boolean).map(Number);
        for (const pid of pids) { killPid(pid, 'SIGTERM'); }
      } catch {}
    }

    // Restart daemon if dead
    let daemonNote = 'daemon was alive';
    if (!isDaemonAlive(sessionId) && accountId) {
      process.stderr.write(`WATCHDOG: Daemon dead. Restarting for ${accountId}/${platform}...\n`);
      restartDaemon(sessionId, accountId, platform);
      daemonNote = 'daemon restarted (allow 10s to connect)';
      await new Promise(r => setTimeout(r, 2000)); // brief pause
    }

    // Build resume message and restart agent
    const resumeMessage = buildResumeMessage(sessionId, checkpoint, sessionStart);
    const targetWorker = workerName || `sm-${platform || 'linkedin'}-1`;

    let restartInfo = { pid: 'unknown', logFile: 'unknown' };
    try {
      restartInfo = restartAgent(sessionId, targetWorker, resumeMessage);
    } catch (e) {
      process.stderr.write(`WATCHDOG: Agent restart failed: ${e.message}\n`);
    }

    console.log(
      `WATCHDOG_RESTART: Session ${sessionId} was frozen (${Math.round(age / 1000)}s). ` +
      `Restarted agent ${targetWorker} (PID ${restartInfo.pid}). ` +
      `${daemonNote}. Log: ${restartInfo.logFile}`
    );
    process.exit(0);
  }

  // ── Phase 4: No JSONL — fall back to legacy heartbeat check ──────────────
  if (legacy) {
    const age = Date.now() - (legacy.lastHeartbeat || 0);

    if (age > LEGACY_STALE_MS) {
      // Kill and restart via legacy executor
      if (legacy.executorPid && isPidAlive(legacy.executorPid)) {
        killPid(legacy.executorPid, 'SIGTERM');
      }
      const child = spawn(process.execPath, [EXECUTOR, sessionId], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      console.log(
        `WATCHDOG_RESTART: Session ${sessionId} stale (${Math.round(age / 60000)}m). ` +
        `Restarted legacy executor (PID ${child.pid}).`
      );
      process.exit(0);
    }

    const runningTask = legacy.tasks?.find(t => t.status === 'running');
    const doneCount = legacy.tasks?.filter(t => t.status === 'done' || t.status === 'skipped').length || 0;
    process.stderr.write(
      `HEARTBEAT_OK: session=${sessionId} tasks=${doneCount}/${legacy.tasks?.length} ` +
      `heartbeat=${Math.round(age / 1000)}s ago` +
      (runningTask ? ` current="${runningTask.label}"` : '') + '\n'
    );
    process.exit(0);
  }

  // No data found at all
  console.log(`WATCHDOG_ERROR: No session data found for ${sessionId}`);
  process.exit(1);
}

main().catch(e => {
  process.stderr.write(`WATCHDOG fatal: ${e.message}\n`);
  process.exit(1);
});
