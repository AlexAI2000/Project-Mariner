#!/usr/bin/env node
// check-mlx-health.js — Verify MultiLogin X launcher is accessible before starting a browser session.
// Exit 0: MLX is up and ready
// Exit 1: MLX is not accessible (agents should NOT fall back to headless)
//
// Usage: node /data/browser-cli/check-mlx-health.js [--verbose]

import https from 'https';

const LAUNCHER_URL = process.env.MLX_LAUNCHER_URL || 'https://launcher.mlx.yt:45001';
const verbose = process.argv.includes('--verbose');

const agent = new https.Agent({ rejectUnauthorized: false });

const req = https.get(`${LAUNCHER_URL}/status`, { agent, timeout: 5000 }, (res) => {
  if (verbose) console.log(`MLX launcher responded: HTTP ${res.statusCode}`);
  if (res.statusCode < 500) {
    console.log(JSON.stringify({ ok: true, message: 'MultiLogin X launcher is accessible', url: LAUNCHER_URL }));
    process.exit(0);
  } else {
    console.error(JSON.stringify({ ok: false, error: `MLX launcher returned HTTP ${res.statusCode}`, url: LAUNCHER_URL }));
    process.exit(1);
  }
});

req.on('error', (err) => {
  console.error(JSON.stringify({
    ok: false,
    error: `MultiLogin X launcher not accessible: ${err.message}`,
    url: LAUNCHER_URL,
    action: 'DO NOT use headless Chromium. Stop and report this error.',
  }));
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.error(JSON.stringify({
    ok: false,
    error: 'MultiLogin X launcher timed out',
    url: LAUNCHER_URL,
    action: 'DO NOT use headless Chromium. Stop and report this error.',
  }));
  process.exit(1);
});
