#!/usr/bin/env node
// exec.js — CLI interface for browser-cli daemon.
// Agents call this for every browser action. Connects to the session daemon
// via Unix socket, sends a JSON-RPC command, prints result and exits.
//
// Usage:
//   node /data/browser-cli/exec.js snapshot --session <id> [--tab <tabId>]
//   node /data/browser-cli/exec.js act --session <id> --ref <eN> --kind <click|fill|type|check|press> [--text "..."] [--tab <tabId>]
//   node /data/browser-cli/exec.js navigate --session <id> --url <url> [--tab <tabId>]
//   node /data/browser-cli/exec.js open-tab --session <id> --url <url>
//   node /data/browser-cli/exec.js switch-tab --session <id> --tab <tabId>
//   node /data/browser-cli/exec.js close-tab --session <id> [--tab <tabId>]
//   node /data/browser-cli/exec.js scroll --session <id> --pixels <n> --direction <up|down> [--tab <tabId>]
//   node /data/browser-cli/exec.js wait --session <id> --ms <n>
//   node /data/browser-cli/exec.js screenshot --session <id> [--path <p>] [--tab <tabId>]
//   node /data/browser-cli/exec.js get-text --session <id> [--tab <tabId>]
//   node /data/browser-cli/exec.js background-breathe --session <id> --tab <tabId>
//   node /data/browser-cli/exec.js checkpoint --session <id> --task <name> --status <done|failed> [--note "..."]
//   node /data/browser-cli/exec.js press-key --session <id> --key <Enter|Tab|...> [--tab <tabId>]
//   node /data/browser-cli/exec.js detect-captcha --session <id> [--tab <tabId>]
//   node /data/browser-cli/exec.js inject-captcha-token --session <id> --token <token> --captcha-type <recaptcha2|recaptcha3|hcaptcha|funcaptcha|turnstile> [--tab <tabId>]
//   node /data/browser-cli/exec.js status --session <id>
//   node /data/browser-cli/exec.js stop --session <id>

import { createConnection } from 'net';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

// ── Arg parsing ────────────────────────────────────────────────────────────────

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

const [, , command, ...rest] = process.argv;
const opts = parseArgs(rest);

if (!command) {
  console.error('Usage: node exec.js <command> --session <id> [options]');
  process.exit(1);
}

const sessionId = opts.session;
if (!sessionId) {
  console.error('--session <id> is required');
  process.exit(1);
}

const SOCKET_PATH = `/tmp/browser-cli-${sessionId}.sock`;

// ── Build RPC params from CLI opts ────────────────────────────────────────────

function buildParams() {
  const method = command.replace(/-/g, '_');
  const params = {};

  if (opts.tab) params.tabId = opts.tab;
  if (opts.ref) params.ref = opts.ref;
  if (opts.kind) params.kind = opts.kind;
  if (opts.text !== undefined) params.text = opts.text;
  if (opts.url) params.url = opts.url;
  if (opts.pixels) params.pixels = parseInt(opts.pixels, 10);
  if (opts.direction) params.direction = opts.direction;
  if (opts.ms) params.ms = parseInt(opts.ms, 10);
  if (opts.path) params.path = opts.path;
  if (opts.task) params.task = opts.task;
  if (opts.status) params.status = opts.status;
  if (opts.note) params.note = opts.note;
  if (opts.key) params.key = opts.key;
  if (opts.completed) params.completedTasksList = opts.completed.split(',');
  if (opts.pending) params.pendingTasksList = opts.pending.split(',');
  if (opts.token) params.token = opts.token;
  if (opts['captcha-type']) params.captchaType = opts['captcha-type'];

  return { method, params };
}

// ── Send command to daemon ─────────────────────────────────────────────────────

function sendToSocket(method, params) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH);
    const id = randomUUID();
    let buffer = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timeout waiting for daemon response (method: ${method})`));
    }, 600000); // 10 min — matches gate.js CMD_TIMEOUT ceiling

    socket.on('connect', () => {
      const msg = JSON.stringify({ id, method, params }) + '\n';
      socket.write(msg);
    });

    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timeout);
            socket.destroy();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch {}
      }
    });

    socket.on('error', err => {
      clearTimeout(timeout);
      reject(new Error(`Socket error: ${err.message}`));
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      // If we get here without resolving, it's a protocol error
    });
  });
}

// ── Format output for agent consumption ───────────────────────────────────────

function formatResult(result, method) {
  if (method === 'snapshot') {
    // Agent reads this to pick refs
    const lines = [`=== SNAPSHOT ===`];
    if (result.tabBar && result.tabCount > 1) {
      lines.push(`Tabs: ${result.tabBar}`);
    }
    lines.push(
      `URL: ${result.url}`,
      `Title: ${result.title}`,
      `Elements (${result.refCount}):`,
      result.list || '(no interactive elements found)',
      `=== END SNAPSHOT ===`,
    );
    return lines.join('\n');
  }

  if (method === 'get_text') {
    return [
      `=== PAGE TEXT ===`,
      `URL: ${result.url}`,
      result.text || '(empty)',
      `=== END PAGE TEXT ===`,
    ].join('\n');
  }

  if (method === 'navigate') {
    return `Navigated to: ${result.url}`;
  }

  if (method === 'open_tab') {
    return `Opened new tab: ${result.tabId} → ${result.url}`;
  }

  if (method === 'switch_tab') {
    return `Switched to tab: ${result.tabId} (${result.url})`;
  }

  if (method === 'checkpoint') {
    return [
      `Checkpoint saved.`,
      `Completed: ${result.completedTasks.join(', ') || 'none'}`,
      `Pending: ${result.pendingTasks.join(', ') || 'none'}`,
    ].join('\n');
  }

  if (method === 'get_status') {
    const lines = [
      `=== SESSION STATUS ===`,
      `Session: ${result.sessionId}`,
      `Account: ${result.accountId} (${result.platform})`,
      `Daemon PID: ${result.pid}`,
      `Current tab: ${result.currentTabId}`,
      `Tabs:`,
      ...result.tabs.map(t => `  ${t.tabId}: ${t.url}`),
      `Completed tasks: ${result.completedTasks.join(', ') || 'none'}`,
      `Pending tasks: ${result.pendingTasks.join(', ') || 'none'}`,
      `=== END STATUS ===`,
    ];
    return lines.join('\n');
  }

  if (method === 'act') {
    const coords = result.x ? ` at (${result.x}, ${result.y})` : '';
    return `Action ${result.kind} on "${result.label}" [${result.ref}]${coords} → OK`;
  }

  if (method === 'screenshot') {
    return `Screenshot saved: ${result.path}`;
  }

  if (method === 'detect_captcha') {
    if (!result.found) return `No CAPTCHA detected on ${result.url}`;
    return [
      `CAPTCHA DETECTED on ${result.url}`,
      `  Type:    ${result.type}`,
      `  SiteKey: ${result.siteKey || '(none — check page source)'}`,
    ].join('\n');
  }

  if (method === 'inject_captcha_token') {
    return `CAPTCHA token injected: type=${result.captchaType} token=${result.tokenPreview}`;
  }

  // Default: JSON
  return JSON.stringify(result, null, 2);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(SOCKET_PATH)) {
    console.error(
      `ERROR: Daemon socket not found at ${SOCKET_PATH}\n` +
      `Start the session first:\n` +
      `  node /data/browser-cli/start-session.js --session ${sessionId} --account <id> --platform <platform>`
    );
    process.exit(1);
  }

  const { method, params } = buildParams();

  try {
    const result = await sendToSocket(method, params);
    const output = formatResult(result, method);
    console.log(output);
    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
