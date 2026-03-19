#!/usr/bin/env node
// humanizer-daemon.js — Mariner Humanizer
//
// Runs as a persistent background daemon for a session.
// Monitors the session JSONL for pending_command events from the Pilot,
// calls the humanizer.js algorithm engine to get a humanized command sequence,
// executes the sequence (ending with a snapshot), and writes the snapshot
// back as command_executed so the Pilot receives a fresh accessibility tree.
//
// Usage: node /data/mariner/humanizer-daemon.js <sessionId> <agentId> <pidFile>
// Exit 0 = session complete naturally, Exit 1 = fatal error

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { join } from 'path';

const SESSIONS_DIR = '/data/sessions';
const HUMANIZER_ENGINE = '/data/mariner/humanizer.js';
const POLL_MS = 400;

const [, , sessionId, agentId = 'mariner-humanizer', pidFile] = process.argv;
if (!sessionId) {
  console.error('Usage: node humanizer-daemon.js <sessionId> <agentId> <pidFile>');
  process.exit(1);
}

// Write PID
if (pidFile) {
  mkdirSync('/tmp', { recursive: true });
  writeFileSync(pidFile, String(process.pid), 'utf8');
}

function sessionPath()   { return join(SESSIONS_DIR, `${sessionId}.jsonl`); }
function humanizerPath() { return join(SESSIONS_DIR, `${sessionId}-humanizer.jsonl`); }

function appendToSession(obj) {
  appendFileSync(sessionPath(), JSON.stringify({ ts: Date.now(), ...obj }) + '\n', 'utf8');
}

function appendToHumanizer(obj) {
  appendFileSync(humanizerPath(), JSON.stringify({ ts: Date.now(), ...obj }) + '\n', 'utf8');
}

function readLines(path) {
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

function isComplete() {
  return readLines(sessionPath()).some(l => {
    try { return JSON.parse(l).type === 'session_complete'; } catch { return false; }
  });
}

// Find the last pending_command that has no matching command_executed
function findPendingCommand() {
  const lines = readLines(sessionPath());
  const executedIds = new Set();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'command_executed' && obj.cmdId) executedIds.add(obj.cmdId);
    } catch { /* skip */ }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === 'pending_command' && obj.cmdId && !executedIds.has(obj.cmdId)) return obj;
    } catch { /* skip */ }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Execute a single shell command, return { output, error, exitCode }
function runCommand(cmd, timeoutMs = 120_000) {
  return new Promise(resolve => {
    const args = parseArgs(cmd);
    const bin = args.shift();
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4, shell: false }, (err, stdout, stderr) => {
      if (err) {
        resolve({ output: stdout || '', error: stderr || err.message, exitCode: err.code || 1 });
      } else {
        resolve({ output: stdout, error: null, exitCode: 0 });
      }
    });
  });
}

// Minimal shell arg parser: splits on spaces but respects single/double quotes
function parseArgs(cmd) {
  const args = [];
  let current = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; }
    else if (c === '"' && !inSingle) { inDouble = !inDouble; }
    else if (c === ' ' && !inSingle && !inDouble) {
      if (current) { args.push(current); current = ''; }
    } else {
      current += c;
    }
  }
  if (current) args.push(current);
  return args;
}

// ── Humanizer Engine Integration ──────────────────────────────────────────────
// Calls humanizer.js to get the humanized command sequence for a raw command.
// Returns { sequence: [cmd,...], logEntry: {...} }
// On any failure, falls back to safe defaults (raw command + snapshot).

async function callHumanizerEngine(rawCommand, sidecarFile) {
  const FALLBACK_SNAPSHOT = 'node /data/browser-cli/exec.js snapshot';

  // Determine if snapshot should be appended (not for pure wait/stop/snapshot cmds)
  const raw = rawCommand.toLowerCase();
  const isMetaCmd = / wait /.test(raw) || / wait$/.test(raw) || raw.includes('stop') ||
                    raw.includes('snapshot') || raw.includes('screenshot') ||
                    raw.includes('checkpoint') || raw.includes('background-breathe') ||
                    raw.includes('get-text');
  const fallbackSequence = isMetaCmd ? [rawCommand] : [rawCommand, FALLBACK_SNAPSHOT];

  try {
    const engineInput = JSON.stringify({ rawCommand, sessionId, sidecarFile });
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [HUMANIZER_ENGINE, engineInput], {
        encoding: 'utf8',
        timeout: 6000,
        maxBuffer: 256 * 1024,
      });
    } catch (e) {
      console.error(`[humanizer-daemon] Engine call failed: ${e.message} — using fallback`);
      return { sequence: fallbackSequence, logEntry: null };
    }

    let parsed;
    try { parsed = JSON.parse(stdout.trim()); }
    catch {
      console.error('[humanizer-daemon] Engine returned invalid JSON — using fallback');
      return { sequence: fallbackSequence, logEntry: null };
    }

    if (!Array.isArray(parsed.sequence) || parsed.sequence.length === 0) {
      return { sequence: fallbackSequence, logEntry: null };
    }

    return { sequence: parsed.sequence, logEntry: parsed.logEntry || null };

  } catch (e) {
    console.error(`[humanizer-daemon] Unexpected engine error: ${e.message} — using fallback`);
    return { sequence: fallbackSequence, logEntry: null };
  }
}

// Execute the full humanized sequence, return the final command's output (the snapshot)
async function executeHumanizedSequence(sequence) {
  let finalOutput = '';
  let finalError = null;
  let finalExitCode = 0;

  for (const cmd of sequence) {
    const isWait = /wait\s+\d+$/.test(cmd.trim());
    const timeoutMs = isWait ? 35_000 : 120_000;

    console.error(`[humanizer-daemon]   → ${cmd.slice(0, 100)}`);
    const result = await runCommand(cmd, timeoutMs);

    if (result.exitCode !== 0) {
      console.error(`[humanizer-daemon]   ✗ exit ${result.exitCode}: ${(result.error || '').slice(0, 120)}`);
      finalError = result.error;
      finalExitCode = result.exitCode;
      // Continue executing the sequence even on error — we always want the snapshot at the end
    } else {
      finalOutput = result.output; // last successful output (snapshot) wins
    }
  }

  return { output: finalOutput, error: finalError, exitCode: finalExitCode };
}

// Load last processed cmdId from humanizer sidecar (crash recovery)
function loadLastProcessedCmdId() {
  const lines = readLines(humanizerPath());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === 'humanizer_state' && obj.lastCmdId) return obj.lastCmdId;
    } catch { /* skip */ }
  }
  return null;
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

console.error(`[humanizer-daemon] Started — session=${sessionId} agent=${agentId} pid=${process.pid}`);
console.error(`[humanizer-daemon] Engine: ${HUMANIZER_ENGINE}`);

const processedCmdIds = new Set();
const lastProcessed = loadLastProcessedCmdId();
if (lastProcessed) {
  processedCmdIds.add(lastProcessed);
  console.error(`[humanizer-daemon] Recovered — last processed cmdId: ${lastProcessed}`);
}

async function loop() {
  while (true) {
    if (isComplete()) {
      console.error('[humanizer-daemon] Session complete — exiting.');
      process.exit(0);
    }

    const pending = findPendingCommand();

    if (pending && !processedCmdIds.has(pending.cmdId)) {
      const { cmdId, cmd } = pending;
      console.error(`[humanizer-daemon] Processing cmdId=${cmdId}: ${cmd.slice(0, 80)}`);

      // Mark as in-progress in sidecar
      appendToHumanizer({ type: 'humanizer_state', agentId, lastCmdId: cmdId, state: 'executing' });

      // ── Get humanized command sequence from the engine ──────────────────────
      const { sequence, logEntry } = await callHumanizerEngine(cmd, humanizerPath());
      console.error(`[humanizer-daemon] Sequence (${sequence.length} cmd${sequence.length !== 1 ? 's' : ''})`);

      // ── Execute sequence ────────────────────────────────────────────────────
      const result = await executeHumanizedSequence(sequence);

      // ── Log what we chose (for anti-pattern enforcement on next call) ───────
      if (logEntry) {
        appendToHumanizer({ type: 'humanizer_params', agentId, cmdId, ...logEntry });
      }

      // ── Write command_executed with snapshot as output ──────────────────────
      // The Pilot receives the accessibility snapshot as the return value of its
      // submit-command.js call — no separate snapshot step needed.
      appendToSession({
        type: 'command_executed',
        agentId,
        cmdId,
        cmd,
        status: result.exitCode === 0 ? 'success' : 'error',
        output: result.output,   // ← This IS the snapshot from exec.js snapshot
        error: result.error || null,
        sequenceLength: sequence.length,
      });

      // ── Mark as done ────────────────────────────────────────────────────────
      appendToHumanizer({ type: 'humanizer_state', agentId, lastCmdId: cmdId, state: 'done' });
      processedCmdIds.add(cmdId);

      const status = result.exitCode === 0 ? 'success' : 'error';
      console.error(`[humanizer-daemon] Done cmdId=${cmdId} status=${status} outputLen=${result.output.length}`);
    }

    await sleep(POLL_MS);
  }
}

loop().catch(err => {
  console.error(`[humanizer-daemon] Fatal: ${err.message}`);
  process.exit(1);
});
