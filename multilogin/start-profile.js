#!/usr/bin/env node
// start-profile.js — Start a MultiLogin X browser profile and output its cdpUrl.
// Registers on fixed port 55000 so openclaw's native browser tool can connect.
//
// Usage: node start-profile.js <profileId> [folderId]
// Output: JSON { success: true, cdpUrl } on stdout
// Exit 0: success  Exit 1: error

import { startProfile } from '/data/multilogin/multilogin.js';

const [, , profileId, folderId] = process.argv;

if (!profileId) {
  console.error('Usage: node start-profile.js <profileId> [folderId]');
  process.exit(1);
}

try {
  const cdpUrl = await startProfile(profileId, folderId || null);
  console.log(JSON.stringify({ success: true, cdpUrl }));
} catch (e) {
  console.error(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
}
