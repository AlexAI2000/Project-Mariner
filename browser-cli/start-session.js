#!/usr/bin/env node
// start-session.js — Launch a browser-cli session daemon for an account.
// Resolves the MLX profile, starts the CDP connection, spawns the daemon.
// Called once at the start of each worker mission.
//
// Usage: node /data/browser-cli/start-session.js --session <id> --account <accountId> --platform <platform> [--tasks "t1,t2,..."]
// Output: JSON { ok, sessionId, daemonPid, cdpUrl, logFile, socketPath }

import { spawnSync, spawn } from 'child_process';
import { existsSync, openSync, readFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

const opts = parseArgs(process.argv.slice(2));
const sessionId = opts.session || `ws-${randomUUID().slice(0, 8)}`;
const accountId = opts.account;
const platform = opts.platform;
const tasks = opts.tasks || '';

if (!accountId || !platform) {
  console.error('Usage: node start-session.js --session <id> --account <accountId> --platform <platform>');
  process.exit(1);
}

const DAEMON_SCRIPT = '/data/browser-cli/session-daemon.js';
const SOCKET_PATH = `/tmp/browser-cli-${sessionId}.sock`;
const PID_PATH = `/tmp/browser-cli-daemon-${sessionId}.pid`;
const LOG_PATH = `/tmp/browser-cli-${sessionId}.log`;

// ── Step 1: Check if daemon already running ─────────────────────────────────

if (existsSync(SOCKET_PATH) && existsSync(PID_PATH)) {
  try {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8'));
    process.kill(pid, 0); // throws if dead
    process.stdout.write(JSON.stringify({
      ok: true,
      sessionId,
      daemonPid: pid,
      resumed: true,
      message: `Daemon already running (PID ${pid}). Session resumed.`,
    }) + '\n');
    process.exit(0);
  } catch { /* stale — continue with fresh start */ }
}

// ── Step 2: Resolve MLX profile ─────────────────────────────────────────────

function resolveProfile() {
  const result = spawnSync(process.execPath, ['/data/executor/pa-lookup.js', accountId, platform], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`pa-lookup failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`pa-lookup bad JSON: ${result.stdout.slice(0, 200)}`);
  }
}

// ── Step 3: Start MLX profile (get CDP URL) ──────────────────────────────────

function startMlxProfile(mlProfileId, folderId) {
  const result = spawnSync(process.execPath, ['/data/multilogin/start-profile.js', mlProfileId, folderId], {
    encoding: 'utf8',
    timeout: 90000,
  });
  if (result.status !== 0) {
    throw new Error(`start-profile failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  try {
    const out = JSON.parse(result.stdout.trim());
    if (!out.success || !out.cdpUrl) throw new Error(out.error || 'No cdpUrl in response');
    return out.cdpUrl;
  } catch (e) {
    throw new Error(`start-profile bad response: ${e.message}`);
  }
}

// ── Step 4: Spawn daemon ─────────────────────────────────────────────────────

function spawnDaemon(cdpUrl) {
  return new Promise((resolve, reject) => {
    const daemonArgs = [
      DAEMON_SCRIPT,
      sessionId,
      cdpUrl,
      '--account', accountId,
      '--platform', platform,
    ];
    if (tasks) daemonArgs.push('--tasks', tasks);

    mkdirSync('/tmp', { recursive: true });
    const logFd = openSync(LOG_PATH, 'a');

    const child = spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();

    // Poll for socket to appear (up to 20s)
    const deadline = Date.now() + 20000;
    const interval = setInterval(() => {
      if (existsSync(SOCKET_PATH)) {
        clearInterval(interval);
        resolve(child.pid);
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        reject(new Error(`Daemon socket never appeared at ${SOCKET_PATH}. Check log: ${LOG_PATH}`));
      }
    }, 250);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let clientProfile, cdpUrl, daemonPid;

  try {
    process.stderr.write(`[start-session] Resolving profile for ${accountId}/${platform}...\n`);
    clientProfile = resolveProfile();
    process.stderr.write(`[start-session] Profile: ${clientProfile.mlProfileId}\n`);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `Profile resolution failed: ${e.message}` }));
    process.exit(1);
  }

  try {
    process.stderr.write(`[start-session] Starting MLX profile ${clientProfile.mlProfileId}...\n`);
    cdpUrl = startMlxProfile(clientProfile.mlProfileId, clientProfile.folderId);
    process.stderr.write(`[start-session] CDP: ${cdpUrl}\n`);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `Browser start failed: ${e.message}` }));
    process.exit(1);
  }

  try {
    process.stderr.write(`[start-session] Spawning daemon...\n`);
    daemonPid = await spawnDaemon(cdpUrl);
    process.stderr.write(`[start-session] Daemon PID=${daemonPid}\n`);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: `Daemon spawn failed: ${e.message}` }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    daemonPid,
    cdpUrl,
    mlProfileId: clientProfile.mlProfileId,
    folderId: clientProfile.folderId,
    logFile: LOG_PATH,
    socketPath: SOCKET_PATH,
    message: `Browser session ready. Daemon PID=${daemonPid}. Log: ${LOG_PATH}`,
  }));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
