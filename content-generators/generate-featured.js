#!/usr/bin/env node
// generate-featured.js — Generates LinkedIn Featured section recommendations using Qwen via OpenRouter.
// Usage: node generate-featured.js '<briefing-json>'
// Output: {"featured": [...]} to stdout
// Exit 0: success  Exit 1: error

import { callLLM } from './lib/llm.js';

const SYSTEM_PROMPT = `You are a LinkedIn profile strategist specializing in the Featured section. This section appears near the top of a LinkedIn profile and is the most powerful real estate for showcasing expertise and attracting opportunities.

RULES:
- Recommend exactly 3-5 items to feature
- Types: "article" (LinkedIn article or post), "link" (external URL), "media" (PDF, image, presentation)
- For each item: write a compelling title (max 60 characters) and description (max 200 characters)
- The title and description are what visitors see — make them curiosity-inducing and value-forward
- If the person has no existing content: suggest what they SHOULD create and feature (be specific)
- Prioritize items that demonstrate expertise, build authority, and attract their target audience
- Think like a buyer/recruiter seeing this profile — what would make them stop and click?

GOOD featured items:
- A case study showing a specific result ("How I grew ARR from $1M to $10M in 18 months")
- A framework or methodology they've developed
- A keynote talk or webinar recording
- A press feature or interview
- A detailed guide or playbook in their area of expertise
- Their company website or portfolio

BAD featured items:
- Generic company website with no context
- Old articles on irrelevant topics
- Items with no clear value proposition

Return ONLY valid JSON, no explanation:
{"featured": [{"type": "article|link|media", "title": "...", "description": "...", "suggestedContent": "What to create/find for this slot"}]}`;

function buildUserPrompt(b) {
  const achievements = Array.isArray(b.achievements) ? b.achievements.join('\n- ') : (b.achievements || 'Not specified');
  return `Name: ${b.name || 'Not provided'}
Job Title: ${b.jobTitle || 'Not provided'}${b.company ? ` at ${b.company}` : ''}
Industry: ${b.industry || 'Not provided'}
Summary: ${b.oneLineSummary || b.background || 'Not provided'}
Key achievements:
- ${achievements}
Target audience: ${b.targetAudience || 'Not provided'}
Any known content they've created (articles, talks, etc.): ${b.existingContent || 'Not provided'}

Design the optimal Featured section for their LinkedIn profile.`;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node generate-featured.js \'{"name":"...","jobTitle":"..."}\'');
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
  if (!Array.isArray(result.featured)) throw new Error('Response missing "featured" array');
  console.log(JSON.stringify(result));
} catch (e) {
  console.error('generate-featured failed:', e.message);
  process.exit(1);
}
