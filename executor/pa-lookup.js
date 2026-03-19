#!/usr/bin/env node
// pa-lookup.js — Personal Assistant lookup script.
// Resolves client context for a given clientId + platform.
// If the client or MultiLogin X profile doesn't exist, creates them automatically.
//
// Usage: node /data/executor/pa-lookup.js <clientId> <platform> [--no-create]
// Output: JSON to stdout
// Exit 0: success  Exit 1: not found / error
//
// --no-create: fail if MultiLogin X profile doesn't exist (no auto-creation)
//
// This script is safe to run in parallel — client-manager handles concurrent writes.

import { resolveClient, readClients } from '/data/clients/client-manager.js';

const args = process.argv.slice(2);
const noCreate = args.includes('--no-create');
const positional = args.filter(a => !a.startsWith('--'));
const [clientId, platform] = positional;

if (!clientId || !platform) {
  console.error('Usage: node pa-lookup.js <clientId> <platform> [--no-create]');
  console.error('Example: node pa-lookup.js john-doe linkedin');
  process.exit(1);
}

if (noCreate) {
  // Static lookup only — do not create MultiLogin X profile
  const clients = readClients();
  const client = clients[clientId];
  if (!client) {
    const available = Object.keys(clients).filter(k => !k.startsWith('_')).join(', ');
    console.error(`Client "${clientId}" not found. Available: ${available || '(none)'}`);
    process.exit(1);
  }
  const mlProfile = client.mlProfiles?.[platform];
  const mlProfileId = mlProfile?.profileId;
  if (!mlProfileId) {
    console.error(`No MultiLogin X profile for "${clientId}" on "${platform}". Run without --no-create to create one.`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    clientId,
    clientName: client.name,
    platform,
    mlProfileId,
    folderId: mlProfile.folderId,
    credentials: client.credentials?.[platform] || null,
    email: client.email || null,
    proxy: client.proxy || null,
    phone: client.phone || null,
    briefing: client.briefing || null,
    isNew: false,
  }, null, 2));
  process.exit(0);
}

// Full resolve — creates client entry and MultiLogin X profile if needed
resolveClient(clientId, platform)
  .then(ctx => {
    console.log(JSON.stringify(ctx, null, 2));
  })
  .catch(e => {
    console.error(`pa-lookup failed: ${e.message}`);
    process.exit(1);
  });
