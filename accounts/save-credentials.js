#!/usr/bin/env node
// save-credentials.js — Save newly created account credentials to clients.json.
//
// Usage:
//   node /data/accounts/save-credentials.js <clientId> <field> <json-value>
//
// Fields:
//   email       — { provider, address, password }
//   linkedin    — { email, password, accountUrl? }
//   instagram   — { email, username, password }
//   twitter     — { email, username, password }
//   facebook    — { email, password }
//   proxy       — { type, host, port, login, password }
//   phone       — "+31612345678"
//
// Examples:
//   node save-credentials.js john-doe email '{"provider":"outlook","address":"john@outlook.com","password":"Abc123!"}'
//   node save-credentials.js john-doe linkedin '{"email":"john@outlook.com","password":"LinkedInPass1!"}'
//   node save-credentials.js john-doe proxy '{"type":"http","host":"proxy.nl","port":8080,"login":"u","password":"p"}'

import { readFileSync, writeFileSync } from 'fs';

const CLIENTS_PATH = '/data/clients/clients.json';

const [,, clientId, field, valueRaw] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!clientId || !field || !valueRaw) {
  fail('Usage: node save-credentials.js <clientId> <field> <json-value>');
}

let value;
try {
  value = JSON.parse(valueRaw);
} catch (e) {
  fail(`Invalid JSON value: ${e.message}`);
}

let clients;
try {
  clients = JSON.parse(readFileSync(CLIENTS_PATH, 'utf8'));
} catch (e) {
  fail(`Cannot read clients.json: ${e.message}`);
}

if (!clients[clientId]) {
  fail(`Client "${clientId}" not found in clients.json. Add them first.`);
}

// Route field to correct location in client record
if (field === 'email') {
  clients[clientId].email = value;
} else if (field === 'proxy') {
  clients[clientId].proxy = value;
} else if (field === 'phone') {
  clients[clientId].phone = value;
} else {
  // Platform credential (linkedin, instagram, twitter, facebook, etc.)
  if (!clients[clientId].credentials) clients[clientId].credentials = {};
  clients[clientId].credentials[field] = value;
}

clients[clientId].updatedAt = new Date().toISOString();

// Atomic write
const tmp = CLIENTS_PATH + '.tmp';
writeFileSync(tmp, JSON.stringify(clients, null, 2));
const { renameSync } = await import('fs');
renameSync(tmp, CLIENTS_PATH);

console.log(JSON.stringify({
  success: true,
  clientId,
  field,
  message: `Saved ${field} credentials for ${clients[clientId].name || clientId}`,
}));
