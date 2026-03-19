#!/usr/bin/env node
// provision-profile.js — Resolves (creates if needed) the MLX proxy + browser profile
// for a given account_id + platform, then fires a callback URL with the result.
//
// Does NOT launch a browser session or an AI agent — profile creation only.
//
// Usage: node provision-profile.js <accountId> <platform> <clientName> <callbackUrl> <executionId>

import { resolveClient } from '/data/clients/client-manager.js';

const [,, accountId, platform, clientName, callbackUrl, executionId] = process.argv;

if (!accountId || !platform || !callbackUrl) {
  process.stderr.write('Usage: provision-profile.js <accountId> <platform> <clientName> <callbackUrl> <executionId>\n');
  process.exit(1);
}

async function run() {
  let payload;
  try {
    process.stderr.write(`[provision-profile] Resolving client ${accountId} / ${platform}...\n`);
    const ctx = await resolveClient(accountId, platform, clientName || accountId);
    payload = {
      execution_id: executionId || null,
      account_id: accountId,
      platform,
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
      platform,
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
