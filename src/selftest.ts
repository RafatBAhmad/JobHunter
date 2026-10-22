/**
 * Offline checks for the model-facing code paths, using a stand-in client:
 *   - web search resumes after pause_turn, then reads the submit_jobs tool call
 *   - web search handles a refusal without throwing
 *   - scoring parses structured output, maps keys back, caps ineligible scores
 * Run: npx tsx src/selftest.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { setClient, usage } from "./claude.js";
import { scoreJobs } from "./score.js";
import { searchWeb } from "./sources/websearch.js";
import type { Job, Profile } from "./types.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8")) as Profile;
const u = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } };
const calls: Array<Record<string, unknown>> = [];

function fake(responses: unknown[]): Anthropic {
  const next = (params: Record<string, unknown>) => {
    calls.push(structuredClone(params));
    const r = responses.shift();
    if (!r) throw new Error("no more fake responses");
    return r;
  };
  return {
    beta: {
      messages: {
        create: async (p: Record<string, unknown>) => next(p),
        stream: (p: Record<string, unknown>) => ({ finalMessage: async () => next(p) }),
      },
    },
  } as unknown as Anthropic;
}

// 1. web search: pause_turn, then submit_jobs
calls.length = 0;
setClient(
  fake([
    { stop_reason: "pause_turn", usage: u, content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "flutter jobs kuala lumpur visa" } }] },
    {
      stop_reason: "tool_use",
      usage: u,
      content: [
        { type: "text", text: "Found these." },
        {
          type: "tool_use",
          id: "t1",
          name: "submit_jobs",
          input: {
            jobs: [
              { title: "Flutter Developer", company: "GrabLike", url: "https://example.my/jobs/1", location: "Kuala Lumpur, Malaysia", work_mode: "onsite", posted: "2026-10-12", visa_sponsorship: "yes", salary: "MYR 9k-12k / month", summary: "Flutter + Firebase; 3+ years; Employment Pass provided." },
              { title: "Bad row", company: "X", url: "not-a-url", location: "", work_mode: "remote", posted: "", visa_sponsorship: "unknown", salary: "", summary: "" },
            ],
          },
        },
      ],
    },
  ]),
);
const web = await searchWeb(profile, ["Old Role — OldCo"]);
assert.equal(web.jobs.length, 1, "invalid URL row is dropped");
assert.equal(web.jobs[0].source, "Web search");
assert.match(web.jobs[0].description, /Visa sponsorship: yes/);
assert.equal(calls.length, 2, "resumed once after pause_turn");
const second = calls[1].messages as Array<{ role: string }>;
assert.equal(second.length, 2, "paused assistant turn appended, no extra user message");
assert.equal(second[1].role, "assistant");
assert.equal(calls[0].fallbacks, "default");
assert.deepEqual(calls[0].betas, ["server-side-fallback-2026-07-01"]);
assert.match(String((calls[0].messages as Array<{ content: string }>)[0].content), /Old Role — OldCo/);
console.log("ok  web search: pause_turn resume + submit_jobs parsing");

// 2. web search: refusal
setClient(fake([{ stop_reason: "refusal", usage: u, content: [] }]));
const refused = await searchWeb(profile, []);
assert.equal(refused.jobs.length, 0);
assert.match(refused.note, /declined/);
console.log("ok  web search: refusal handled");

// 3. scoring
const jobs: Job[] = [
  { id: "a", source: "T", title: "Flutter Engineer", company: "A", url: "https://a", location: "Worldwide", description: "Flutter", tags: [] },
  { id: "b", source: "T", title: "Backend Engineer", company: "B", url: "https://b", location: "US only", description: "Node", tags: [] },
];
calls.length = 0;
setClient(
  fake([
    {
      stop_reason: "end_turn",
      usage: u,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { key: "j1", score: 88, eligible: "no", eligibility_reason: "أمريكا فقط", fit_reasons: "Node", red_flags: "", pitch: "" },
              { key: "j0", score: 91, eligible: "yes", eligibility_reason: "عن بعد عالمياً", fit_reasons: "Flutter", red_flags: "", pitch: "I build Flutter apps..." },
              { key: "j9", score: 99, eligible: "yes", eligibility_reason: "", fit_reasons: "", red_flags: "", pitch: "" },
            ],
          }),
        },
      ],
    },
  ]),
);
const { scored, errors } = await scoreJobs(profile, jobs);
assert.deepEqual(errors, []);
assert.equal(scored.length, 2, "unknown key ignored");
assert.equal(scored[0].id, "a");
assert.equal(scored[0].score, 91);
assert.equal(scored[1].score, 39, "ineligible capped below 40");
const fmt = (calls[0].output_config as { format: { type: string } }).format;
assert.equal(fmt.type, "json_schema");
console.log("ok  scoring: structured output parsed, keys mapped, ineligible capped");

assert.ok(usage.input > 0 && usage.webSearches > 0);
console.log("ok  usage tracked:", usage);
