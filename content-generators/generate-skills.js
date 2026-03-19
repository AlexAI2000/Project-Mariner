#!/usr/bin/env node
// generate-skills.js — Generates an optimized LinkedIn skills list using Qwen via OpenRouter.
// Usage: node generate-skills.js '<briefing-json>'
// Output: {"skills": ["Skill One", "Skill Two", ...]} to stdout
// Exit 0: success  Exit 1: error

import { callLLM } from './lib/llm.js';

const SYSTEM_PROMPT = `You are a LinkedIn skills optimization expert. You select the ideal mix of skills that maximizes profile visibility in recruiter searches, signals the right expertise, and gets the most relevant endorsements.

RULES:
- Return exactly 20 skills (LinkedIn allows 50, but 20 well-chosen skills beat 50 generic ones)
- COMPOSITION (approximate):
  - 8 hard/technical skills specific to their role and tools they use
  - 8 domain/industry skills (strategic, functional expertise)
  - 4 leadership/soft skills (only the highest-impact ones)
- ORDER: most important and searchable first
- Use EXACT LinkedIn skill names where known — these power LinkedIn's search algorithm
  (e.g., "Demand Generation" not "Demand Gen", "Search Engine Optimization" not "SEO work")
- Do NOT include generic skills: "Microsoft Office", "Communication", "Teamwork", "Hard Working"
- Do NOT include soft skills that everyone has — only genuinely differentiating ones
- Prioritize skills that their target audience (recruiters, clients, partners) searches for

Return ONLY valid JSON, no explanation: {"skills": ["Skill One", "Skill Two", ...]}`;

function buildUserPrompt(b) {
  const existingSkills = Array.isArray(b.skills)
    ? `Existing skills to include/refine: ${b.skills.join(', ')}`
    : '';
  return `Name: ${b.name || 'Not provided'}
Job Title: ${b.jobTitle || 'Not provided'}
Industry: ${b.industry || 'Not provided'}
Years of experience: ${b.yearsExperience || 'Not provided'}
Summary: ${b.oneLineSummary || b.background || 'Not provided'}
${existingSkills}
Target audience (who needs to find them): ${b.targetAudience || 'Not provided'}
Platform: ${b.platform || 'LinkedIn'}

Generate the optimal 20 skills for this professional's LinkedIn profile.`;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node generate-skills.js \'{"jobTitle":"...","industry":"..."}\'');
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
  const result = await callLLM(SYSTEM_PROMPT, buildUserPrompt(briefing));
  if (!Array.isArray(result.skills)) throw new Error('Response missing "skills" array');
  console.log(JSON.stringify(result));
} catch (e) {
  console.error('generate-skills failed:', e.message);
  process.exit(1);
}
