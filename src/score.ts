/**
 * Scores new jobs against the profile with structured JSON output, in batches.
 * Returns only jobs the model scored; a failed batch is logged and skipped.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { claude, fallbackParams, MODEL, track } from "./claude.js";
import type { Job, Profile, Scored } from "./types.js";

const BATCH = 20;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "score", "eligible", "eligibility_reason", "fit_reasons", "red_flags", "pitch"],
        properties: {
          key: { type: "string" },
          score: { type: "integer", description: "0-100 overall fit" },
          eligible: { type: "string", enum: ["yes", "no", "unclear"] },
          eligibility_reason: { type: "string", description: "Arabic, one sentence: can he be hired from Palestine / with sponsorship in MY, ID or TR?" },
          fit_reasons: { type: "string", description: "Arabic, one or two short sentences on why it fits." },
          red_flags: { type: "string", description: "Arabic, short; empty string if none." },
          pitch: { type: "string", description: "English, two sentences he can open his application with; empty string when score < 70." },
        },
      },
    },
  },
} as const;

function systemPrompt(profile: Profile): string {
  return `You screen job postings for one candidate and score how well each fits him.

<candidate>
${JSON.stringify(profile, null, 2)}
</candidate>

Scoring guide (0-100):
- 85-100: core stack match (Flutter, NestJS/Node/TypeScript, Next.js/React, or Java/Spring Boot), right seniority, clearly hireable from Palestine (worldwide/EMEA/MENA remote) or sponsored relocation to Malaysia, Indonesia or Turkey.
- 70-84: strong match with one gap (adjacent stack, unclear region but not excluded, English demands slightly high).
- 50-69: partial match; worth a look only if nothing better.
- below 50: poor match, or eligibility is "no".
Eligibility: "no" when the posting restricts hiring to countries he cannot work from, requires on-site work outside Malaysia/Indonesia/Turkey, or needs work authorization he lacks. "unclear" when the posting says only "remote" with no region. When eligible is "no", the score must be below 40.
Judge only from what the posting says. Do not invent requirements or benefits.
Return one result per posting, using its key.`;
}

function formatJobs(jobs: Job[]): string {
  return jobs
    .map(
      (j, i) =>
        `<posting key="j${i}">\nTitle: ${j.title}\nCompany: ${j.company}\nLocation: ${j.location}\nSource: ${j.source}\n${j.salary ? `Salary: ${j.salary}\n` : ""}Tags: ${j.tags.join(", ")}\n${j.description}\n</posting>`,
    )
    .join("\n\n");
}

async function scoreBatch(profile: Profile, jobs: Job[]): Promise<Scored[]> {
  const message = await claude().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: systemPrompt(profile), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Score these ${jobs.length} postings.\n\n${formatJobs(jobs)}` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    ...fallbackParams(),
  });
  track(message.usage);
  if (message.stop_reason === "refusal") throw new Error("scoring declined by the model");
  if (message.stop_reason === "max_tokens") throw new Error("scoring output truncated");

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as { results: Array<Omit<Scored, keyof Job> & { key: string }> };

  const byKey = new Map(jobs.map((j, i) => [`j${i}`, j]));
  return parsed.results.flatMap((r) => {
    const job = byKey.get(r.key);
    if (!job) return [];
    const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
    return [{ ...job, score: r.eligible === "no" ? Math.min(score, 39) : score, eligible: r.eligible, eligibility_reason: r.eligibility_reason, fit_reasons: r.fit_reasons, red_flags: r.red_flags, pitch: r.pitch }];
  });
}

export async function scoreJobs(profile: Profile, jobs: Job[]): Promise<{ scored: Scored[]; errors: string[] }> {
  const scored: Scored[] = [];
  const errors: string[] = [];
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    try {
      scored.push(...(await scoreBatch(profile, batch)));
    } catch (err) {
      errors.push(`batch ${i / BATCH + 1}: ${(err as Error).message}`);
    }
  }
  return { scored: scored.sort((a, b) => b.score - a.score), errors };
}
