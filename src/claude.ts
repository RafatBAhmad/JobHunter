import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
/** Test hook: inject a stand-in client (see src/selftest.ts). */
export function setClient(c: Anthropic): void {
  client = c;
}
export function claude(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

/**
 * Server-side refusal fallback ("default" routes by refusal category).
 * Haiku 5.5 has no server-side fallback, so the field is left off for it.
 */
export function fallbackParams(): { betas: string[]; fallbacks?: "default" } {
  if (MODEL.startsWith("claude-haiku")) return { betas: [] };
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

/** Running token/cost tally, printed at the end of each run. */
export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };

export function track(u: Anthropic.Beta.BetaUsage | undefined): void {
  if (!u) return;
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.cacheRead += u.cache_read_input_tokens ?? 0;
  usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  usage.webSearches += u.server_tool_use?.web_search_requests ?? 0;
}
