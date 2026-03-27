#!/usr/bin/env node
// provision-profile.js — Resolves (creates if needed) the MLX proxy + browser profile
// for a given account_id, then fires a callback URL with the result.
//
// Does NOT launch a browser session or an AI agent — profile creation only.
//
// Usage: node provision-profile.js <accountId> <clientName> <callbackUrl> <executionId> [proxyString]
// proxyString (optional): "host:port:username:password" — bypasses auto proxy generation.

import { resolveClient } from '/data/clients/client-manager.js';

const [,, accountId, clientName, callbackUrl, executionId, proxyString] = process.argv;

if (!accountId || !callbackUrl) {
  process.stderr.write('Usage: provision-profile.js <accountId> <clientName> <callbackUrl> <executionId> [proxyString]\n');
  process.exit(1);
}

// Parse "host:port:username:password" into a proxy config object.
function parseProxyString(str) {
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length < 4) return null;
  const [host, port, ...rest] = parts;
  // username may contain colons — everything except the last part is username
  const password = rest.pop();
  const username = rest.join(':');
  return { type: 'http', host, port: parseInt(port, 10), login: username, password };
}

async function run() {
  let payload;
  try {
    const proxyOverride = parseProxyString(proxyString);
    if (proxyOverride) {
      process.stderr.write(`[provision-profile] Using supplied proxy: ${proxyOverride.host}:${proxyOverride.port}\n`);
    }
    process.stderr.write(`[provision-profile] Resolving client ${accountId}...\n`);
    const ctx = await resolveClient(accountId, clientName || accountId, proxyOverride);
    payload = {
      execution_id: executionId || null,
      account_id: accountId,
      status: 'provisioned',
      mlProfileId: ctx.mlProfileId,
      folderId: ctx.folderId,
      isNew: ctx.isNew,
    };
    process.stderr.write(`[provision-profile] OK mlProfileId=${ctx.mlProfileId} isNew=${ctx.isNew}\n`);
  } catch (e) {
    payload = {
      execution_id: executionId || null,
      account_id: accountId,
      status: 'error',
      error: e.message,
    };
    process.stderr.write(`[provision-profile] FAILED: ${e.message}\n`);
  }

  // Fire callback
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    process.stderr.write(`[provision-profile] Callback fired → HTTP ${res.status}\n`);
  } catch (e2) {
    process.stderr.write(`[provision-profile] Callback failed: ${e2.message}\n`);
  }

  process.exit(payload.status === 'error' ? 1 : 0);
}

run();
