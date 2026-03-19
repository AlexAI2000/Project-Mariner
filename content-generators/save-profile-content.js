#!/usr/bin/env node
// save-profile-content.js — Merges generated profile content into a client's profileContent section.
// Usage: node save-profile-content.js <clientId> '<content-json>'
// Content JSON can have any subset of: headline, bio, workHistory, skills, featured
// Existing non-null fields are preserved unless overwritten.
// Exit 0: success  Exit 1: error

import { readFileSync, writeFileSync, existsSync } from 'fs';

const CLIENTS_FILE = '/data/clients/clients.json';
const VALID_FIELDS = ['headline', 'bio', 'workHistory', 'skills', 'featured'];

const [, , clientId, contentInput] = process.argv;

if (!clientId || !contentInput) {
  console.error('Usage: node save-profile-content.js <clientId> \'{"headline":"...","bio":"..."}\'');
  process.exit(1);
}

let content;
try {
  content = JSON.parse(contentInput);
} catch (e) {
  console.error('Invalid JSON content:', e.message);
  process.exit(1);
}

if (!existsSync(CLIENTS_FILE)) {
  console.error('Clients file not found. Run save-briefing.js first to create the client entry.');
  process.exit(1);
}

let clients;
try {
  clients = JSON.parse(readFileSync(CLIENTS_FILE, 'utf8'));
} catch (e) {
  console.error('Failed to read clients file:', e.message);
  process.exit(1);
}

if (!clients[clientId]) {
  console.error(`Client "${clientId}" not found in clients.json. Add them first.`);
  process.exit(1);
}

// Ensure profileContent section exists
if (!clients[clientId].profileContent) {
  clients[clientId].profileContent = {
    headline: null, bio: null, workHistory: null, skills: null, featured: null, generatedAt: null
  };
}

const updated = [];
for (const field of VALID_FIELDS) {
  if (content[field] != null) {
    clients[clientId].profileContent[field] = content[field];
    updated.push(field);
  }
}

if (updated.length > 0) {
  clients[clientId].profileContent.generatedAt = new Date().toISOString();
}

writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
console.log(JSON.stringify({ ok: true, clientId, fieldsUpdated: updated }));
