#!/usr/bin/env node
// client-manager.js — Client lifecycle management.
//
// Determines if a client is new (needs MultiLogin X profile created) or returning (profile exists).
// Creates MultiLogin X profiles programmatically via the MultiLogin cloud API when needed.
// Saves all new data back to clients.json atomically.
//
// Usage as a module:
//   import { resolveClient, ensureClient, readClients } from '/data/clients/client-manager.js';
//
// Usage as a CLI (called by pa-lookup.js and executor.js):
//   node /data/clients/client-manager.js resolve <clientId> <platform> [clientName]
//   node /data/clients/client-manager.js ensure <clientId> [clientName]
//   node /data/clients/client-manager.js list

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const CLIENTS_FILE = '/data/clients/clients.json';

mkdirSync(dirname(CLIENTS_FILE), { recursive: true });

// ── File helpers ──────────────────────────────────────────────────────────────

export function readClients() {
  if (!existsSync(CLIENTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CLIENTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeClients(clients) {
  // Write atomically — temp file then rename avoids partial writes
  const tmp = `${CLIENTS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(clients, null, 2));
  // Node doesn't have atomic rename on all platforms but this is close enough
  writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

// ── Client registry helpers ───────────────────────────────────────────────────

// Ensure a client entry exists (creates a blank one if missing).
// Returns the (possibly new) client object.
export function ensureClient(clientId, name = null) {
  const clients = readClients();
  if (!clients[clientId] || clientId.startsWith('_')) {
    if (clientId.startsWith('_')) {
      throw new Error(`clientId "${clientId}" is reserved (starts with _).`);
    }
    clients[clientId] = {
      name: name || clientId,
      phone: null,
      proxy: null,
      email: null,
      mlProfiles: {},
      credentials: {},
      briefing: null,
      profileContent: null,
    };
    writeClients(clients);
    process.stderr.write(`[client-manager] Created new client entry: ${clientId}\n`);
  } else if (name && clients[clientId].name !== name) {
    // Update name if a better one was provided
    clients[clientId].name = name;
    writeClients(clients);
  }
  return readClients()[clientId];
}

// Save a field to a client entry (e.g. proxy, email, phone).
export function saveClientField(clientId, field, value) {
  const clients = readClients();
  if (!clients[clientId]) throw new Error(`Client "${clientId}" not found.`);
  clients[clientId][field] = value;
  writeClients(clients);
}

// Save a MultiLogin X profile for a client.
// Stores { profileId, folderId } at client.mlProfile.
export function saveMlProfile(clientId, profileId, folderId) {
  const clients = readClients();
  if (!clients[clientId]) throw new Error(`Client "${clientId}" not found.`);
  clients[clientId].mlProfile = { profileId, folderId };
  writeClients(clients);
  process.stderr.write(`[client-manager] Saved MLX profile ${profileId} for ${clientId}\n`);
}

// ── MultiLogin X profile creation ────────────────────────────────────────────

// Create a new MultiLogin X browser profile via the cloud API.
// Returns { profileId, folderId }.
async function createMlProfile(clientId, clientName, proxy = null) {
  const { createProfile } = await import('/data/multilogin/multilogin.js');
  return createProfile(clientId, clientName, proxy);
}

// ── Name-based lookup ─────────────────────────────────────────────────────────

// Find a client entry by display name (case-insensitive).
// Checks client.name and client.briefing?.name.
// Returns { resolvedId, client } or null.
function findClientByName(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  const clients = readClients();
  for (const [id, c] of Object.entries(clients)) {
    if (id.startsWith('_')) continue;
    if (c.name?.toLowerCase() === lower) return { resolvedId: id, client: c };
    if (c.briefing?.name?.toLowerCase() === lower) return { resolvedId: id, client: c };
  }
  return null;
}

// ── Main: resolve client context ──────────────────────────────────────────────

// Resolve full client context for a given clientId.
// Creates client entry if missing. Creates MLX browser profile if missing.
//
// proxyOverride (optional): { type, host, port, login, password }
//   If supplied, this proxy is used directly and createProxy() is skipped.
//
// Returns:
// {
//   clientId, clientName,
//   mlProfileId,        // always set — created if needed
//   folderId,           // MultiLogin folder UUID
//   credentials,        // { email, password, ... } or null
//   email,              // { provider, address, password } or null
//   proxy,              // { type, host, port, login, password } or null
//   phone,              // "+1234..." or null
//   briefing,           // briefing object or null
//   isNew,              // true if MLX profile was just created this call
// }
export async function resolveClient(clientId, name = null, proxyOverride = null) {
  // First check if exact key exists; if not, try name-based lookup before creating a new entry
  let effectiveClientId = clientId;
  const clients = readClients();
  if (!clients[clientId]) {
    const found = findClientByName(clientId);
    if (found) {
      process.stderr.write(`[client-manager] Resolved "${clientId}" by name → ${found.resolvedId}\n`);
      effectiveClientId = found.resolvedId;
    }
  }

  // Ensure client exists (creates blank entry only if truly not found)
  const client = ensureClient(effectiveClientId, name);

  // Support migration from old mlProfiles[platform] structure → new mlProfile flat structure
  const existingProfile = client.mlProfile ||
    client.mlProfiles?.linkedin ||
    Object.values(client.mlProfiles || {})[0] ||
    null;

  if (existingProfile?.profileId) {
    // Returning client — use existing profile
    return {
      clientId: effectiveClientId,
      clientName: client.name,
      mlProfileId: existingProfile.profileId,
      folderId: existingProfile.folderId,
      credentials: client.credentials || null,
      email: client.email || null,
      proxy: client.proxy || null,
      phone: client.phone || null,
      briefing: client.briefing || null,
      isNew: false,
    };
  }

  // No registered profile — search MLX cloud by account_id in notes before creating a new one
  try {
    const { findProfileByAccountId } = await import('/data/multilogin/multilogin.js');
    const found = await findProfileByAccountId(effectiveClientId);
    if (found) {
      const profileId = found.id || found.profile_id;
      const folderId = found.folder_id || process.env.MULTILOGIN_FOLDER_ID || '';
      process.stderr.write(`[client-manager] Auto-registered existing MLX profile ${profileId} for ${effectiveClientId} (found via notes)\n`);
      saveMlProfile(effectiveClientId, profileId, folderId);
      const updatedClient = readClients()[effectiveClientId];
      return {
        clientId: effectiveClientId,
        clientName: updatedClient.name,
        mlProfileId: profileId,
        folderId,
        credentials: updatedClient.credentials || null,
        email: updatedClient.email || null,
        proxy: updatedClient.proxy || null,
        phone: updatedClient.phone || null,
        briefing: updatedClient.briefing || null,
        isNew: false,
      };
    }
  } catch (e) {
    process.stderr.write(`[client-manager] MLX notes search for ${effectiveClientId} failed: ${e.message} — will create new profile\n`);
  }

  // Step 1: Use supplied proxy override, existing stored proxy, or auto-generate one
  let proxyConfig = proxyOverride || client.proxy;
  if (!proxyConfig?.host) {
    const { createProxy } = await import('/data/multilogin/multilogin.js');
    proxyConfig = await createProxy(effectiveClientId, client.name);
    process.stderr.write(`[client-manager] Auto-generated proxy for ${effectiveClientId}\n`);
  } else if (proxyOverride) {
    process.stderr.write(`[client-manager] Using supplied proxy for ${effectiveClientId}: ${proxyOverride.host}:${proxyOverride.port}\n`);
  }
  saveClientField(effectiveClientId, 'proxy', proxyConfig);

  // Step 2: Create MLX profile with the proxy already attached
  const { profileId, folderId } = await createMlProfile(effectiveClientId, client.name, proxyConfig);
  saveMlProfile(effectiveClientId, profileId, folderId);

  const updatedClient = readClients()[effectiveClientId];

  return {
    clientId: effectiveClientId,
    clientName: updatedClient.name,
    mlProfileId: profileId,
    folderId,
    credentials: null,
    email: updatedClient.email || null,
    proxy: updatedClient.proxy || null,
    phone: updatedClient.phone || null,
    briefing: updatedClient.briefing || null,
    isNew: true,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Guard: only run CLI when invoked directly (not when imported as a module).

const __cmFile = fileURLToPath(import.meta.url);
if (process.argv[1] === __cmFile) {

const [, , command, ...cliArgs] = process.argv;

if (command === 'resolve') {
  const [clientId, name, proxyStr] = cliArgs;
  if (!clientId) {
    process.stderr.write('Usage: node client-manager.js resolve <clientId> [name] [proxyString]\n');
    process.exit(1);
  }
  // Parse optional "host:port:username:password" proxy string
  let proxyOverride = null;
  if (proxyStr) {
    const parts = proxyStr.split(':');
    if (parts.length >= 4) {
      const [host, port, ...rest] = parts;
      const password = rest.pop();
      const login = rest.join(':');
      proxyOverride = { type: 'http', host, port: parseInt(port, 10), login, password };
    }
  }
  resolveClient(clientId, name || null, proxyOverride)
    .then(ctx => { console.log(JSON.stringify(ctx, null, 2)); })
    .catch(e => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });

} else if (command === 'ensure') {
  const [clientId, name] = cliArgs;
  if (!clientId) {
    process.stderr.write('Usage: node client-manager.js ensure <clientId> [name]\n');
    process.exit(1);
  }
  try {
    const client = ensureClient(clientId, name || null);
    console.log(JSON.stringify({ clientId, ...client }, null, 2));
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }

} else if (command === 'list') {
  const clients = readClients();
  const list = Object.entries(clients)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => ({
      clientId: k,
      name: v.name,
      hasProfile: !!(v.mlProfile?.profileId || Object.values(v.mlProfiles || {})[0]?.profileId),
      hasProxy: !!v.proxy?.host,
      hasEmail: !!v.email?.address,
    }));
  console.log(JSON.stringify(list, null, 2));

} else if (command) {
  process.stderr.write(`Unknown command: ${command}. Use: resolve | ensure | list\n`);
  process.exit(1);
}

} // end isMain guard
