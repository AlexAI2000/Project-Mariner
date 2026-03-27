#!/usr/bin/env node
// gate.js — The Slicer-Relay Gate
// VPS API gateway that connects Lovable to the browser automation infrastructure.
//
// Start:  node /data/gate.js
// PM2:    pm2 start /data/gate.js --name slicer-relay-gate
// Port:   4567 (override with GATE_PORT env var)
//
// Endpoints:
//   POST /mariner/session/start      — open a browser session (async, fires callback)
//   POST /mariner/session/stop       — close a browser session
//   GET  /mariner/session/:id/status — check if a session daemon is alive
//   POST /mariner/execute            — execute a browser command in a live session
//   GET  /health                     — health check (no auth)

'use strict';

const http = require('http');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.GATE_PORT   || '4567', 10);
const GATE_SECRET = process.env.GATE_SECRET || process.env.MARINER_API_TOKEN || '';
const CMD_TIMEOUT = 600_000;   // 10 min absolute ceiling — respects client timeoutMs
const SES_TIMEOUT = 180_000;   // 3 min max for session start (MLX profile can be slow)
const LOG_FILE    = '/tmp/slicer-gate.log';

// Only these prefixes are allowed in /mariner/execute raw_command
const ALLOWED_PREFIXES = [
  'node /data/browser-cli/exec.js',
  'node /data/executor/',
  'node /data/mariner/',
  'node /data/multilogin/',
  'node /data/clients/',
  'node /data/accounts/',
  'node /data/captcha/',
  'node /data/content-generators/',
  'node /data/img-gen/',
];

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const rateMap = new Map(); // ip → { count, windowStart }

function checkRate(ip, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  const e = rateMap.get(ip);
  if (!e || now - e.windowStart > windowMs) { rateMap.set(ip, { count: 1, windowStart: now }); return true; }
  if (e.count >= limit) return false;
  e.count++;
  return true;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 512_000) reject(new Error('body too large')); });
    req.on('end',  () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Content-Length':              Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':'Authorization, Content-Type',
  });
  res.end(json);
}

function validateToken(req) {
  if (!GATE_SECRET) return true;
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') && auth.slice(7) === GATE_SECRET;
}

// ─── Humanizer integration ────────────────────────────────────────────────────
//
// Before executing a raw_command, gate calls mariner/humanizer.js to get a
// humanized sequence: [optional pre-wait, core command, snapshot].
// This adds persona-driven idle delays + anti-pattern enforcement on top of
// the physics-level humanization (Bézier curves, typing errors, scroll bursts)
// that session-daemon.js always applies automatically.

function injectSession(cmd, sessionId) {
  if (!sessionId || cmd.includes('--session')) return cmd;
  // Fix wait format: "exec.js wait 1247" → "exec.js wait --session <id> --ms 1247"
  const waitMatch = cmd.match(/exec\.js\s+wait\s+(\d+)\s*$/);
  if (waitMatch) return cmd.replace(/wait\s+(\d+)\s*$/, `wait --session ${sessionId} --ms ${waitMatch[1]}`);
  // All other commands (snapshot, etc.): append --session
  return cmd + ` --session ${sessionId}`;
}

function getHumanizedSequence(rawCommand, sessionId) {
  const sidecarFile = sessionId ? `/data/sessions/${sessionId}-humanizer.jsonl` : null;
  const input = JSON.stringify({ rawCommand, sessionId: sessionId || '', sidecarFile });

  // Fallback sequence if humanizer engine fails
  const isMetaCmd = /\s(stop|snapshot|screenshot|checkpoint|get-text|background-breathe)\b/.test(rawCommand)
                 || rawCommand.endsWith(' stop');
  const fallbackSnapshot = sessionId
    ? `node /data/browser-cli/exec.js snapshot --session ${sessionId}`
    : null;
  const fallback = isMetaCmd || !fallbackSnapshot ? [rawCommand] : [rawCommand, fallbackSnapshot];

  return new Promise(resolve => {
    exec(`node /data/mariner/humanizer.js '${input.replace(/'/g, "'\\''")}'`, { timeout: 6000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) {
        log('warn', 'humanizer engine failed — using fallback', { err: err.message });
        return resolve(fallback);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (Array.isArray(parsed.sequence) && parsed.sequence.length > 0) {
          const fixed = parsed.sequence.map(c => injectSession(c, sessionId));
          return resolve(fixed);
        }
      } catch (e) {
        log('warn', 'humanizer returned invalid JSON — using fallback', { err: e.message });
      }
      resolve(fallback);
    });
  });
}

async function runSequence(sequence, timeoutMs) {
  let finalStdout = '';
  let screenshotStdout = '';
  let finalStderr = '';
  let success = true;
  let totalMs = 0;
  let timedOut = false;

  for (const cmd of sequence) {
    const isWait       = /exec\.js\s+wait\b/.test(cmd);
    const isScreenshot = /exec\.js\s+screenshot\b/.test(cmd);
    const t = Math.min(timeoutMs, CMD_TIMEOUT);
    const r = await runCommand(cmd, t);
    totalMs += r.durationMs;
    if (r.timedOut) timedOut = true;
    if (!r.success) {
      finalStderr = r.stderr;
      success = false;
      // Keep executing — always want the snapshot at the end
    } else if (isScreenshot) {
      screenshotStdout = r.stdout || screenshotStdout; // capture screenshot path separately
    } else {
      finalStdout = r.stdout || finalStdout; // last non-screenshot output (snapshot) wins
    }
  }

  return { success, stdout: finalStdout, screenshotStdout, stderr: finalStderr, durationMs: totalMs, timedOut };
}

// ─── Command helpers ──────────────────────────────────────────────────────────

function sanitize(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'raw_command must be a non-empty string' };
  const t = raw.trim();
  const stripped = t.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q');
  if (/[;&|`$><]/.test(stripped)) return { ok: false, reason: 'command contains disallowed shell metacharacters' };
  if (!ALLOWED_PREFIXES.some(p => t.startsWith(p))) return { ok: false, reason: 'command prefix not in allowlist' };
  return { ok: true, command: t };
}

function runCommand(command, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        success:    !err || err.code === 0,
        stdout:     stdout  || '',
        stderr:     stderr  || (err ? err.message : ''),
        durationMs: Date.now() - t0,
        timedOut:   !!(err && err.killed),
      });
    });
  });
}

function extractScreenshot(stdout) {
  const m = stdout.match(/[Ss]creenshot saved[:\s]+([^\s\n]+\.png)/);
  if (!m) return null;
  try { return fs.readFileSync(m[1]).toString('base64'); } catch { return null; }
}

// ─── Callback (async, non-blocking) ──────────────────────────────────────────

function fireCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  try {
    const url = new URL(callbackUrl);
    if (url.protocol !== 'https:') { log('warn', 'callback skipped — not https', { callbackUrl }); return; }
    const body = JSON.stringify(payload);
    const https = require('https');
    const req = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, () => {});
    req.on('error', e => log('warn', 'callback failed', { callbackUrl, err: e.message }));
    req.write(body);
    req.end();
    log('info', 'callback fired', { callbackUrl, event: payload.event || 'result' });
  } catch (e) {
    log('warn', 'callback error', { callbackUrl, err: e.message });
  }
}

// ─── Session status check ─────────────────────────────────────────────────────

function getSessionStatus(sessionId) {
  const socketPath = `/tmp/browser-cli-${sessionId}.sock`;
  const pidPath    = `/tmp/browser-cli-daemon-${sessionId}.pid`;
  const alive = fs.existsSync(socketPath);
  let pid = null;
  let daemonAlive = false;
  if (fs.existsSync(pidPath)) {
    try {
      pid = parseInt(fs.readFileSync(pidPath, 'utf8'));
      process.kill(pid, 0);
      daemonAlive = true;
    } catch { daemonAlive = false; }
  }
  return { sessionId, socketReady: alive, daemonAlive, pid };
}

// ─── HTTP Router ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const ip  = req.socket.remoteAddress || 'unknown';
  const url = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  // ── GET /health (no auth) ─────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, {
      status:  'ok',
      service: 'slicer-relay-gate',
      uptime:  Math.floor(process.uptime()),
      pid:     process.pid,
    });
  }

  // ── Auth gate for all other routes ────────────────────────────────────────
  if (!validateToken(req)) {
    log('warn', 'unauthorized', { ip, url });
    return send(res, 401, { success: false, error: 'unauthorized' });
  }

  if (!checkRate(ip)) {
    log('warn', 'rate limit', { ip });
    return send(res, 429, { success: false, error: 'rate limit exceeded' });
  }

  // ── POST /mariner/session/start ───────────────────────────────────────────
  //
  // Opens a MultiLogin X browser profile and starts the session daemon.
  // Responds immediately with 202 + { accepted, sessionId }.
  // Fires callbackUrl when the browser is fully ready (or on failure).
  //
  if (req.method === 'POST' && url === '/mariner/session/start') {
    let body;
    try { body = await parseBody(req); } catch (e) { return send(res, 400, { success: false, error: e.message }); }

    const accountId  = body.accountId || body.account_id;
    const clientName = body.clientName || body.client_name;
    const callbackUrl = body.callbackUrl || body.callback_url;
    const executionId = body.executionId || body.callback_metadata?.execution_id || crypto.randomUUID();
    const sessionId   = body.sessionId || `ms-${crypto.randomUUID().slice(0, 8)}`;

    if (!accountId) {
      return send(res, 400, { success: false, error: 'accountId (or account_id) is required' });
    }

    log('info', 'session start requested', { executionId, sessionId, accountId });

    // Respond immediately — browser startup takes 10–60s
    send(res, 202, {
      accepted:    true,
      sessionId,
      executionId,
      accountId,
      message:     'Browser session starting. Callback will fire when ready.',
    });

    // Start the browser in background
    const args = ['--session', sessionId, '--account', accountId];
    if (clientName) args.push('--clientName', clientName);

    const t0 = Date.now();
    runCommand(`node /data/browser-cli/start-session.js ${args.join(' ')}`, SES_TIMEOUT)
      .then(result => {
        let parsed = {};
        try { parsed = JSON.parse(result.stdout.trim()); } catch {}

        const payload = {
          event:       'session_ready',
          success:     result.success && parsed.ok === true,
          executionId,
          sessionId,
          accountId,
          daemonPid:   parsed.daemonPid   || null,
          cdpUrl:      parsed.cdpUrl       || null,
          mlProfileId: parsed.mlProfileId  || null,
          socketPath:  parsed.socketPath   || null,
          logFile:     parsed.logFile      || null,
          durationMs:  Date.now() - t0,
          error:       result.success ? (parsed.ok ? null : parsed.error) : result.stderr,
        };

        log('info', payload.success ? 'session ready' : 'session start failed', {
          executionId, sessionId, durationMs: payload.durationMs,
        });

        fireCallback(callbackUrl, payload);
      });

    return;
  }

  // ── POST /mariner/session/stop ────────────────────────────────────────────
  //
  // Gracefully stops a session daemon and closes the browser profile.
  // Synchronous — responds when done.
  //
  if (req.method === 'POST' && url === '/mariner/session/stop') {
    let body;
    try { body = await parseBody(req); } catch (e) { return send(res, 400, { success: false, error: e.message }); }

    const { sessionId, executionId = crypto.randomUUID() } = body;
    if (!sessionId) return send(res, 400, { success: false, error: 'sessionId is required' });

    log('info', 'session stop requested', { executionId, sessionId });

    const result = await runCommand(
      `node /data/browser-cli/stop-session.js --session ${sessionId}`,
      30_000,
    );

    let parsed = {};
    try { parsed = JSON.parse(result.stdout.trim()); } catch {}

    return send(res, result.success ? 200 : 500, {
      success:     result.success && parsed.ok !== false,
      executionId,
      sessionId,
      message:     parsed.message || result.stderr || 'stopped',
      durationMs:  result.durationMs,
    });
  }

  // ── GET /mariner/session/:id/status ──────────────────────────────────────
  //
  // Returns whether the session daemon socket exists and the process is alive.
  //
  const statusMatch = url.match(/^\/mariner\/session\/([^/]+)\/status$/);
  if (req.method === 'GET' && statusMatch) {
    const sessionId = statusMatch[1];
    const status = getSessionStatus(sessionId);
    return send(res, 200, {
      success: true,
      ready:   status.socketReady && status.daemonAlive,
      ...status,
    });
  }

  // ── POST /mariner/execute ─────────────────────────────────────────────────
  //
  // Execute a single browser command (exec.js) in a live session.
  // Synchronous — streams back stdout as the result (snapshot, action, etc.).
  //
  if (req.method === 'POST' && url === '/mariner/execute') {
    let body;
    try { body = await parseBody(req); } catch (e) { return send(res, 400, { success: false, error: e.message }); }

    const sessionId      = body.sessionId;
    const accountId      = body.accountId || body.account_id;
    const raw_command    = body.raw_command;
    const callbackUrl    = body.callbackUrl || body.callback_url;
    const executionId    = body.executionId || body.callback_metadata?.execution_id || crypto.randomUUID();
    const expectScreenshot = body.expectScreenshot || false;
    const timeoutMs      = body.timeoutMs || CMD_TIMEOUT;

    if (!raw_command) return send(res, 400, { success: false, error: 'raw_command is required' });

    const sanity = sanitize(raw_command);
    if (!sanity.ok) {
      log('warn', 'command rejected', { executionId, reason: sanity.reason });
      return send(res, 400, { success: false, error: sanity.reason });
    }

    log('info', 'executing command', { executionId, sessionId, command: sanity.command });

    // Get humanized sequence (pre-action delay + core command + auto-snapshot)
    const sequence = await getHumanizedSequence(sanity.command, sessionId);

    // When expectScreenshot, inject a screenshot command before the final snapshot so
    // runSequence captures its output separately (not overwritten by snapshot text).
    if (expectScreenshot && sessionId) {
      const hasScreenshot = sequence.some(c => /exec\.js\s+screenshot\b/.test(c));
      if (!hasScreenshot) {
        const screenshotCmd = `node /data/browser-cli/exec.js screenshot --session ${sessionId}`;
        // Insert before the last snapshot; if no snapshot exists, append at end
        let insertAt = sequence.length; // default: append
        for (let i = sequence.length - 1; i >= 0; i--) {
          if (/exec\.js\s+snapshot\b/.test(sequence[i])) { insertAt = i; break; }
        }
        sequence.splice(insertAt, 0, screenshotCmd);
      }
    }

    log('info', 'humanized sequence', { executionId, steps: sequence.length, expectScreenshot });
    const result = await runSequence(sequence, Math.min(timeoutMs || CMD_TIMEOUT, CMD_TIMEOUT));

    // Extract base64 screenshot from the dedicated screenshot command output
    let screenshotBase64 = null;
    if (result.screenshotStdout) {
      screenshotBase64 = extractScreenshot(result.screenshotStdout);
    } else if (result.stdout.includes('Screenshot saved')) {
      // Fallback: screenshot path was in the main output (e.g. raw screenshot command)
      screenshotBase64 = extractScreenshot(result.stdout);
    }

    const response = {
      success:         result.success,
      executionId,
      sessionId:       sessionId   || null,
      accountId:       accountId   || null,
      stdout:          result.stdout,
      stderr:          result.stderr,
      screenshotBase64,
      durationMs:      result.durationMs,
      timedOut:        result.timedOut,
    };

    log('info', 'command done', { executionId, success: result.success, durationMs: result.durationMs });

    send(res, result.success ? 200 : 500, response);
    fireCallback(callbackUrl, response);
    return;
  }

  // ── POST /mariner/native-click ────────────────────────────────────────────
  //
  // Fires a native X11 mouse click at (x, y) via xdotool on DISPLAY=:99.
  // Bypasses Playwright entirely — reaches browser-native UI elements
  // (e.g. "Save Password" dialogs) invisible to the accessibility tree.
  //
  // Body: { x: number, y: number, executionId?: string }
  //
  if (req.method === 'POST' && url === '/mariner/native-click') {
    let body;
    try { body = await parseBody(req); } catch (e) { return send(res, 400, { success: false, error: e.message }); }

    const { x, y, executionId = crypto.randomUUID() } = body;

    if (typeof x !== 'number' || typeof y !== 'number') {
      return send(res, 400, { success: false, error: 'x and y must be numbers' });
    }

    const xi = Math.round(x);
    const yi = Math.round(y);
    const holdMs = 150 + Math.floor(Math.random() * 151); // 150–300 ms humanized hold

    log('info', 'native-click fired', { executionId, x: xi, y: yi, holdMs });

    const t0 = Date.now();
    // Route click through the click-server running inside visual-vps (172.18.0.3:45055).
    // The browser (Mimic) renders on DISPLAY=:1 inside visual-vps — xdotool must run
    // there, not on the host display. click-server.py translates HTTP → xdotool on :1.
    const CLICK_SERVER = `http://172.18.0.3:45055/click`;
    const result = await new Promise(resolve => {
      const body = JSON.stringify({ x: xi, y: yi, holdMs });
      const http = require('http');
      const url = new URL(CLICK_SERVER);
      const req = http.request({
        hostname: url.hostname,
        port:     parseInt(url.port || '80', 10),
        path:     url.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  5000,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          resolve({
            success:    res.statusCode === 200 && parsed.ok === true,
            stderr:     parsed.error || '',
            durationMs: Date.now() - t0,
          });
        });
      });
      req.on('error', e => resolve({ success: false, stderr: e.message, durationMs: Date.now() - t0 }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, stderr: 'click-server timeout', durationMs: Date.now() - t0 }); });
      req.write(body);
      req.end();
    });

    log('info', result.success ? 'native-click ok' : 'native-click failed', {
      executionId, x: xi, y: yi, durationMs: result.durationMs, err: result.stderr || null,
    });

    return send(res, result.success ? 200 : 500, {
      success:    result.success,
      executionId,
      x:          xi,
      y:          yi,
      holdMs,
      durationMs: result.durationMs,
      error:      result.success ? null : result.stderr,
    });
  }

  send(res, 404, { success: false, error: 'endpoint not found' });
});

server.on('error', e => { log('error', 'server error', { err: e.message }); process.exit(1); });

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Slicer-Relay Gate started', { port: PORT, pid: process.pid });
});

process.on('SIGTERM', () => { log('info', 'SIGTERM — shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { log('info', 'SIGINT — shutting down');  server.close(() => process.exit(0)); });
