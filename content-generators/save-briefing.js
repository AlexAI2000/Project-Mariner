#!/usr/bin/env node
// save-briefing.js — Saves or updates a client briefing in /data/clients/clients.json.
// Usage: node save-briefing.js <clientId> '<briefing-json>'
// Creates the client entry if it doesn't exist yet.
// Merges fields — existing fields are preserved unless overwritten.
// Exit 0: success  Exit 1: error

import { readFileSync, writeFileSync, existsSync } from 'fs';

const CLIENTS_FILE = '/data/clients/clients.json';

const [, , clientId, briefingInput] = process.argv;

if (!clientId || !briefingInput) {
  console.error('Usage: node save-briefing.js <clientId> \'{"jobTitle":"...","company":"..."}\'');
  process.exit(1);
}

let briefing;
try {
  briefing = JSON.parse(briefingInput);
} catch (e) {
  console.error('Invalid JSON briefing:', e.message);
  process.exit(1);
}

let clients = {};
if (existsSync(CLIENTS_FILE)) {
  try {
    clients = JSON.parse(readFileSync(CLIENTS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read clients file:', e.message);
    process.exit(1);
  }
}

// Create client entry if missing
if (!clients[clientId]) {
  clients[clientId] = {
    name: briefing.name || clientId,
    briefing: {},
    profileContent: { headline: null, bio: null, workHistory: null, skills: null, featured: null, generatedAt: null },
    mlProfiles: {},
    credentials: {},
  };
}

// Merge briefing fields (don't overwrite existing with null/undefined)
const existing = clients[clientId].briefing || {};
clients[clientId].briefing = {
  ...existing,
  ...Object.fromEntries(Object.entries(briefing).filter(([, v]) => v != null)),
  updatedAt: new Date().toISOString(),
};

// Update name if provided
if (briefing.name) clients[clientId].name = briefing.name;

writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
console.log(JSON.stringify({ ok: true, clientId, fieldsUpdated: Object.keys(briefing) }));
