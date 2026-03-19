// jsonl-logger.js — Append-only JSONL event stream for browser sessions.
// Every action, snapshot, and checkpoint is recorded here.
// Watchdog reads this file to detect freezes and restore state.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SESSIONS_DIR = '/data/sessions';
mkdirSync(SESSIONS_DIR, { recursive: true });

function sessionPath(sessionId) {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

function write(sessionId, obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
  appendFileSync(sessionPath(sessionId), line, 'utf8');
}

// ── Writers ────────────────────────────────────────────────────────────────────

export function logSessionStart(sessionId, { accountId, platform, tasks }) {
  write(sessionId, { type: 'session_start', accountId, platform, tasks });
}

export function logNavigate(sessionId, { tabId, url, result = 'ok' }) {
  write(sessionId, { type: 'navigate', tabId, url, result });
}

export function logSnapshot(sessionId, { tabId, url, refCount }) {
  write(sessionId, { type: 'snapshot', tabId, url, refCount });
}

export function logAction(sessionId, { action, ref, kind, tabId, label, x, y, text, result }) {
  write(sessionId, { type: 'action', action, ref, kind, tabId, label, x, y, text, result });
}

export function logTabOpen(sessionId, { tabId, url }) {
  write(sessionId, { type: 'tab_open', tabId, url });
}

export function logTabSwitch(sessionId, { fromTabId, toTabId }) {
  write(sessionId, { type: 'tab_switch', fromTabId, toTabId });
}

export function logTabClose(sessionId, { tabId }) {
  write(sessionId, { type: 'tab_close', tabId });
}

export function logScroll(sessionId, { tabId, pixels, direction }) {
  write(sessionId, { type: 'scroll', tabId, pixels, direction });
}

export function logWait(sessionId, { ms }) {
  write(sessionId, { type: 'wait', ms });
}

export function logError(sessionId, { error, context }) {
  write(sessionId, { type: 'error', error, context });
}

export function logTaskComplete(sessionId, { task, status, note }) {
  write(sessionId, { type: 'task_complete', task, status, note });
}

// Checkpoint: full recoverable state. Watchdog reads last checkpoint to resume.
export function logCheckpoint(sessionId, { completedTasks, pendingTasks, tabState, currentTabId, daemonPid }) {
  write(sessionId, {
    type: 'checkpoint',
    completedTasks,
    pendingTasks,
    tabState,    // [{ tabId, url }]
    currentTabId,
    daemonPid,
  });
}

export function logSessionEnd(sessionId, { status, summary }) {
  write(sessionId, { type: 'session_end', status, summary });
}

// ── CAPTCHA Events ─────────────────────────────────────────────────────────────

export function logCaptchaDetected(sessionId, { tabId, captchaType, siteKey, url }) {
  write(sessionId, { type: 'captcha_detected', tabId, captchaType, siteKey, url });
}

export function logCaptchaInjected(sessionId, { tabId, captchaType }) {
  write(sessionId, { type: 'captcha_injected', tabId, captchaType });
}

// ── Mariner Apex Signal Bus ────────────────────────────────────────────────────
// These events coordinate the Pilot ↔ Humanizer ↔ Assistant triad.

// Pilot writes this before handing off a command to the Humanizer.
export function logPendingCommand(sessionId, { agentId, cmd, cmdId }) {
  write(sessionId, { type: 'pending_command', agentId, cmd, cmdId });
}

// Humanizer writes this after successfully executing a command.
export function logCommandExecuted(sessionId, { agentId, status, cmd, cmdId, output, error }) {
  write(sessionId, { type: 'command_executed', agentId, status, cmd, cmdId, output, error });
}

// Assistant writes this to unblock the Pilot for the next turn.
export function logReadyForNext(sessionId, { agentId, cmdId }) {
  write(sessionId, { type: 'signal', status: 'ready_for_next', agentId, cmdId });
}

// Pilot writes this when the entire mission is accomplished.
export function logSessionComplete(sessionId, { agentId, summary }) {
  write(sessionId, { type: 'session_complete', status: 'mission_accomplished', agentId, summary });
}

// Humanizer writes to its own sidecar JSONL for crash recovery.
export function logHumanizerState(sessionId, { agentId, lastCmdId, state }) {
  const line = JSON.stringify({ ts: Date.now(), type: 'humanizer_state', agentId, lastCmdId, state }) + '\n';
  appendFileSync(join(SESSIONS_DIR, `${sessionId}-humanizer.jsonl`), line, 'utf8');
}

// ── Readers (used by watchdog + exec.js resume) ───────────────────────────────

export function readLastLine(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}

export function readLastCheckpoint(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'checkpoint') return obj;
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

// Returns the most recent pending_command that has NO matching command_executed.
// Used by the Humanizer to pick up work.
export function readLastPendingCommand(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    // Collect all executed cmdIds
    const executedIds = new Set();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'command_executed' && obj.cmdId) executedIds.add(obj.cmdId);
      } catch { /* skip */ }
    }
    // Find last pending_command not yet executed
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'pending_command' && obj.cmdId && !executedIds.has(obj.cmdId)) return obj;
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

// Returns true if the session has been marked complete.
export function isSessionComplete(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return false;
  try {
    const content = readFileSync(path, 'utf8');
    return content.includes('"session_complete"');
  } catch { return false; }
}

// Returns the output of the most recent command_executed matching cmdId.
export function readCommandOutput(sessionId, cmdId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'command_executed' && obj.cmdId === cmdId) return obj;
      } catch { /* skip */ }
    }
    return null;
  } catch { return null; }
}

// Returns true if a ready_for_next signal exists for the given cmdId (or any recent one).
export function hasReadyForNext(sessionId, afterTs) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return false;
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.ts < afterTs) break; // Only look at events after our pending_command
        if (obj.type === 'signal' && obj.status === 'ready_for_next') return true;
      } catch { /* skip */ }
    }
    return false;
  } catch { return false; }
}

// Returns { mtimeMs, lineCount } — used by watchdog to detect freezes
export function getJsonlStats(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    const content = readFileSync(path, 'utf8');
    const lineCount = content.trim().split('\n').filter(Boolean).length;
    return { mtimeMs: stat.mtimeMs, lineCount };
  } catch { return null; }
}
