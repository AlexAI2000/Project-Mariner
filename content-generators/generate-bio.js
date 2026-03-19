#!/usr/bin/env node
// generate-bio.js — Generates a professional bio/About section using Qwen via OpenRouter.
// Usage: node generate-bio.js '<briefing-json>'
// Output: {"bio": "..."} to stdout
// Exit 0: success  Exit 1: error

import { callLLM } from './lib/llm.js';

const SYSTEM_PROMPT = `You are an expert professional bio writer specializing in LinkedIn "About" sections and social media profiles. You craft compelling bios that tell a human story, build credibility, and end with a clear call to action.

RULES FOR LINKEDIN (default):
- Write in first person ("I help...", "I've spent...", "My approach...")
- 3-4 paragraphs, each with a distinct purpose
- Paragraph 1 (Hook): Who they are and the core problem they solve
- Paragraph 2 (Approach): Their unique method, philosophy, or point of view
- Paragraph 3 (Proof): Key achievements with specifics and numbers where possible
- Paragraph 4 (CTA): What they're open to, what they're building, or how to reach them
- Maximum 2,600 characters total
- Conversational yet authoritative — reads like a confident human, not a job listing
- No buzzwords: "passionate", "guru", "thought leader", "synergy", "leverage" (as a verb)
- Use line breaks between paragraphs

FOR INSTAGRAM: Keep under 150 characters. Punchy, personality-forward, emojis OK.
FOR TWITTER/X: Keep under 160 characters. Witty or direct. One clear identity statement.
FOR FACEBOOK: 255 characters max for "Intro". Warm, community-oriented tone.

Return ONLY valid JSON, no explanation: {"bio": "..."}`;

function buildUserPrompt(b) {
  const achievements = Array.isArray(b.achievements) ? b.achievements.join('\n- ') : (b.achievements || 'Not specified');
  const wh = Array.isArray(b.workHistory)
    ? b.workHistory.map(w => `${w.role} at ${w.company} (${w.startYear}–${w.endYear || 'present'})`).join(', ')
    : 'Not provided';
  return `Name: ${b.name || 'Not provided'}
Job Title: ${b.jobTitle || 'Not provided'}${b.company ? ` at ${b.company}` : ''}
Industry: ${b.industry || 'Not provided'}
Years of experience: ${b.yearsExperience || 'Not provided'}
Summary: ${b.oneLineSummary || b.background || 'Not provided'}
Work history: ${wh}
Key achievements:
- ${achievements}
Target audience: ${b.targetAudience || 'Not provided'}
Personality/tone notes: ${b.personality || 'Professional but approachable'}
Platform: ${b.platform || 'LinkedIn'}

Write a compelling bio for this person. Match the platform's style and character limits.`;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node generate-bio.js \'{"name":"...","jobTitle":"..."}\'');
  process.exit(1);
}

let briefing;
try {
  briefing = JSON.parse(input);
} catch (e) {
  console.error('Invalid JSON briefing:', e.message);
  process.exit(1);
}

try {
  const result = await callLLM(SYSTEM_PROMPT, buildUserPrompt(briefing), 1500);
  if (!result.bio) throw new Error('Response missing "bio" field');
  console.log(JSON.stringify(result));
} catch (e) {
  console.error('generate-bio failed:', e.message);
  process.exit(1);
}
