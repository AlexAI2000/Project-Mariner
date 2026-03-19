#!/usr/bin/env node
// stop-session.js — Gracefully stop a browser-cli session daemon.
// Sends a stop command via socket, then kills process if it doesn't exit.
//
// Usage: node /data/browser-cli/stop-session.js --session <id>

import { createConnection } from 'net';
import { existsSync, readFileSync, unlinkSync } from 'fs';
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
const sessionId = opts.session;

if (!sessionId) {
  console.error('Usage: node stop-session.js --session <id>');
  process.exit(1);
}

const SOCKET_PATH = `/tmp/browser-cli-${sessionId}.sock`;
const PID_PATH = `/tmp/browser-cli-daemon-${sessionId}.pid`;

async function main() {
  // Try graceful stop via socket
  if (existsSync(SOCKET_PATH)) {
    await new Promise(resolve => {
      const socket = createConnection(SOCKET_PATH);
      const id = randomUUID();

      socket.on('connect', () => {
        socket.write(JSON.stringify({ id, method: 'stop', params: {} }) + '\n');
      });

      socket.on('data', () => { socket.destroy(); resolve(); });
      socket.on('error', resolve);
      socket.on('close', resolve);

      setTimeout(resolve, 3000);
    });
  }

  // Force kill if PID file exists
  if (existsSync(PID_PATH)) {
    try {
      const pid = parseInt(readFileSync(PID_PATH, 'utf8'));
      process.kill(pid, 'SIGTERM');
      process.stderr.write(`[stop-session] Sent SIGTERM to PID ${pid}\n`);
    } catch { /* already dead */ }

    // Clean up files
    try { unlinkSync(PID_PATH); } catch {}
    try { unlinkSync(SOCKET_PATH); } catch {}
  }

  console.log(JSON.stringify({ ok: true, sessionId, message: 'Session stopped.' }));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
