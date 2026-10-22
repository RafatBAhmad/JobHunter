/**
 * Claude searches the web (server-side web_search / web_fetch) for roles the free
 * feeds miss: relocation roles in Malaysia, Indonesia and Turkey, and remote roles
 * on Arabic / Gulf / MENA boards. Results come back through a strict client tool.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { claude, fallbackParams, MODEL, track } from "../claude.js";
import type { Job, Profile } from "../types.js";
import { hash } from "../util.js";

type Found = {
  title: string;
  company: string;
  url: string;
  location: string;
  work_mode: "remote" | "hybrid" | "onsite";
  posted: string;
  visa_sponsorship: "yes" | "no" | "unknown";
  salary: string;
  summary: string;
};

const SUBMIT_TOOL: Anthropic.Beta.BetaTool = {
  name: "submit_jobs",
  description:
    "Submit the job postings you found and verified. Call it exactly once, at the end, with every qualifying posting (an empty list if none qualified).",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["jobs"],
    properties: {
      jobs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "company", "url", "location", "work_mode", "posted", "visa_sponsorship", "salary", "summary"],
          properties: {
            title: { type: "string" },
            company: { type: "string" },
            url: { type: "string", description: "Direct link to this specific posting (not a search-results page)." },
            location: { type: "string", description: "City, country, or the remote region the posting states." },
            work_mode: { type: "string", enum: ["remote", "hybrid", "onsite"] },
            posted: { type: "string", description: "Posting date as shown (YYYY-MM-DD if known), else empty string." },
            visa_sponsorship: { type: "string", enum: ["yes", "no", "unknown"] },
            salary: { type: "string", description: "Salary as stated, else empty string." },
            summary: { type: "string", description: "2-4 sentences: stack, seniority, key requirements, and any relocation/visa wording." },
          },
        },
      },
    },
  },
};

function buildPrompt(profile: Profile, avoid: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. You are a job researcher working for one candidate. Find CURRENT, real job postings that fit him.

<candidate>
${JSON.stringify(profile, null, 2)}
</candidate>

Search in three areas:
1. Relocation roles in Malaysia, Indonesia or Turkey (Kuala Lumpur, Penang, Jakarta, Bali, Istanbul, Ankara, Izmir, ...) for full-stack, backend (Node.js/NestJS/TypeScript or Java/Spring Boot) or Flutter engineers where the employer sponsors visas / work permits, offers relocation, or clearly hires foreigners. Useful sources: LinkedIn job pages, JobStreet, Glints, Kalibrr, Tech in Asia Jobs, Kariyer.net, Relocate.me, company career pages.
2. Remote roles open to candidates in the Middle East / MENA / Gulf, including Arabic-language boards and Gulf companies hiring remotely (baaeed.com, Bayt, Wuzzuf, LinkedIn).
3. Remote "worldwide" / "anywhere" / EMEA roles for Flutter, NestJS, Next.js or Spring Boot engineers on boards other than Remotive, RemoteOK, Himalayas, Jobicy and We Work Remotely (for example Wellfound, Working Nomads, Arc.dev, company career pages).

Rules:
- Only postings published within roughly the last 21 days (when a date is visible) that still appear open.
- Each result needs a direct URL to that specific posting. Never submit a search-results page, and never invent a posting, a URL, or a detail you did not see.
- Skip roles that the candidate's "exclude" list rules out, and on-site roles outside Malaysia, Indonesia and Turkey.
- Skip postings already known to the candidate: ${avoid.length ? avoid.join(" | ") : "(none yet)"}
- Aim for quality over volume: up to 25 postings.

When you are done searching, call submit_jobs once with everything that qualified.`;
}

export async function searchWeb(profile: Profile, avoid: string[]): Promise<{ jobs: Job[]; note: string }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildPrompt(profile, avoid.slice(0, 80)) }];
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: 15 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    SUBMIT_TOOL,
  ];
  let nudged = false;

  for (let turn = 0; turn < 8; turn++) {
    const message = await claude()
      .beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        output_config: { effort: "medium" },
        tools,
        messages,
        ...fallbackParams(),
      })
      .finalMessage();
    track(message.usage);

    if (message.stop_reason === "refusal") return { jobs: [], note: "web search declined by the model" };

    const submit = message.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "submit_jobs",
    );
    if (submit) {
      if (message.stop_reason === "max_tokens") return { jobs: [], note: "web search output was truncated" };
      const found = ((submit.input as { jobs?: Found[] })?.jobs ?? []).filter((f) => f && f.title && /^https?:\/\//.test(f.url));
      return { jobs: found.map(toJob), note: `${found.length} jobs` };
    }

    if (message.stop_reason === "pause_turn") {
      // Server-side loop hit its iteration cap; re-send so it resumes where it stopped.
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    if (message.stop_reason === "end_turn" && !nudged) {
      nudged = true;
      messages.push({ role: "assistant", content: message.content });
      messages.push({ role: "user", content: "Please call submit_jobs now with the postings you found (an empty list if none qualified)." });
      continue;
    }
    return { jobs: [], note: `web search ended without results (stop_reason: ${message.stop_reason})` };
  }
  return { jobs: [], note: "web search hit the turn limit" };
}

function toJob(f: Found): Job {
  const visa = f.visa_sponsorship === "yes" ? "Visa sponsorship: yes." : f.visa_sponsorship === "no" ? "Visa sponsorship: no." : "Visa sponsorship: not stated.";
  return {
    id: `web:${hash(f.url)}`,
    source: "Web search",
    title: f.title,
    company: f.company,
    url: f.url,
    location: `${f.location} (${f.work_mode})`,
    description: `${f.summary}\n${visa}`,
    tags: [f.work_mode, f.visa_sponsorship === "yes" ? "visa-sponsorship" : ""].filter(Boolean),
    salary: f.salary || undefined,
    postedAt: /^\d{4}-\d{2}-\d{2}/.test(f.posted) ? f.posted : undefined,
  };
}
