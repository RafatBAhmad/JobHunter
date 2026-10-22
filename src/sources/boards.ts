/**
 * Free public job-board feeds (no API key). Each board has a pure `map*` function
 * (tested against fixtures) and a fetcher. A failing board never stops the run.
 * Terms: Remotive and RemoteOK ask for a link back to the original posting, which
 * every report keeps; they also ask not to poll more than a few times a day.
 */
import { XMLParser } from "fast-xml-parser";
import type { Job } from "../types.js";
import { arr, getJson, getText, hash, str, toText } from "../util.js";

type Raw = Record<string, unknown>;

// ── Remotive ─────────────────────────────────────────────────────────────────
export function mapRemotive(data: unknown): Job[] {
  const jobs = ((data as Raw)?.jobs ?? []) as Raw[];
  return jobs.map((j) => ({
    id: `remotive:${str(j.id)}`,
    source: "Remotive",
    title: str(j.title),
    company: str(j.company_name),
    url: str(j.url),
    location: str(j.candidate_required_location) || "Remote",
    description: toText(j.description),
    tags: arr(j.tags),
    salary: str(j.salary) || undefined,
    postedAt: str(j.publication_date) || undefined,
  }));
}

async function remotive(): Promise<Job[]> {
  const out: Job[] = [];
  for (const q of ["software-dev", "devops"]) {
    out.push(...mapRemotive(await getJson(`https://remotive.com/api/remote-jobs?category=${q}&limit=150`)));
  }
  return out;
}

// ── RemoteOK ─────────────────────────────────────────────────────────────────
export function mapRemoteOk(data: unknown): Job[] {
  const rows = (Array.isArray(data) ? data : []) as Raw[];
  return rows
    .filter((j) => j && (j.position || j.title)) // first element is a legal notice
    .map((j) => {
      const min = Number(j.salary_min) || 0;
      const max = Number(j.salary_max) || 0;
      return {
        id: `remoteok:${str(j.id) || hash(str(j.url))}`,
        source: "RemoteOK",
        title: str(j.position) || str(j.title),
        company: str(j.company),
        url: str(j.url) || str(j.apply_url),
        location: str(j.location) || "Remote",
        description: toText(j.description),
        tags: arr(j.tags),
        salary: min || max ? `$${min.toLocaleString()}–$${max.toLocaleString()}` : undefined,
        postedAt: str(j.date) || undefined,
      };
    });
}

async function remoteOk(): Promise<Job[]> {
  return mapRemoteOk(await getJson("https://remoteok.com/api"));
}

// ── Himalayas ────────────────────────────────────────────────────────────────
export function mapHimalayas(data: unknown): Job[] {
  const jobs = ((data as Raw)?.jobs ?? []) as Raw[];
  return jobs.map((j) => {
    const restrictions = arr(j.locationRestrictions);
    const tz = arr(j.timezoneRestrictions);
    const min = Number(j.minSalary) || 0;
    const max = Number(j.maxSalary) || 0;
    const pub = Number(j.pubDate);
    return {
      id: `himalayas:${str(j.guid) || hash(str(j.applicationLink) + str(j.title))}`,
      source: "Himalayas",
      title: str(j.title),
      company: str(j.companyName),
      url: str(j.applicationLink) || str(j.guid),
      location: [restrictions.length ? restrictions.join(", ") : "Worldwide", tz.length ? `TZ ${tz.join("/")}` : ""].filter(Boolean).join(" · "),
      description: toText(j.description || j.excerpt),
      tags: [...arr(j.categories), ...arr(j.seniority)],
      salary: min || max ? `${str(j.currency) || "USD"} ${min.toLocaleString()}–${max.toLocaleString()}` : undefined,
      postedAt: pub ? new Date(pub * (pub < 1e12 ? 1000 : 1)).toISOString() : undefined,
    };
  });
}

async function himalayas(): Promise<Job[]> {
  const out: Job[] = [];
  for (let offset = 0; offset < 100; offset += 20) {
    out.push(...mapHimalayas(await getJson(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`)));
  }
  return out;
}

// ── Jobicy ───────────────────────────────────────────────────────────────────
export function mapJobicy(data: unknown): Job[] {
  const jobs = ((data as Raw)?.jobs ?? []) as Raw[];
  return jobs.map((j) => {
    const min = Number(j.annualSalaryMin) || 0;
    const max = Number(j.annualSalaryMax) || 0;
    return {
      id: `jobicy:${str(j.id)}`,
      source: "Jobicy",
      title: str(j.jobTitle),
      company: str(j.companyName),
      url: str(j.url),
      location: str(j.jobGeo) || "Remote",
      description: toText(j.jobDescription || j.jobExcerpt),
      tags: [...arr(j.jobIndustry), ...arr(j.jobType), str(j.jobLevel)].filter(Boolean),
      salary: min || max ? `${str(j.salaryCurrency) || "USD"} ${min.toLocaleString()}–${max.toLocaleString()}` : undefined,
      postedAt: str(j.pubDate) || undefined,
    };
  });
}

async function jobicy(): Promise<Job[]> {
  const out: Job[] = [];
  for (const tag of ["flutter", "nestjs", "node", "typescript", "react", "java", "full-stack"]) {
    out.push(...mapJobicy(await getJson(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(tag)}`)));
  }
  return out;
}

// ── We Work Remotely (RSS) ───────────────────────────────────────────────────
export function mapWwr(xml: string): Job[] {
  const parsed = new XMLParser({ ignoreAttributes: true }).parse(xml) as Raw;
  const channel = ((parsed?.rss as Raw)?.channel ?? {}) as Raw;
  const items = (Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : []) as Raw[];
  return items.map((it) => {
    const full = str(it.title);
    const idx = full.indexOf(":");
    const link = str(it.link) || str(it.guid);
    return {
      id: `wwr:${hash(link)}`,
      source: "WeWorkRemotely",
      title: idx > 0 ? full.slice(idx + 1).trim() : full,
      company: idx > 0 ? full.slice(0, idx).trim() : "",
      url: link,
      location: str(it.region) || "Remote",
      description: toText(it.description),
      tags: arr(it.category),
      postedAt: it.pubDate ? new Date(str(it.pubDate)).toISOString() : undefined,
    };
  });
}

async function wwr(): Promise<Job[]> {
  const out: Job[] = [];
  for (const cat of ["remote-full-stack-programming-jobs", "remote-back-end-programming-jobs", "remote-front-end-programming-jobs"]) {
    out.push(...mapWwr(await getText(`https://weworkremotely.com/categories/${cat}.rss`)));
  }
  return out;
}

export const BOARDS: Record<string, () => Promise<Job[]>> = {
  Remotive: remotive,
  RemoteOK: remoteOk,
  Himalayas: himalayas,
  Jobicy: jobicy,
  WeWorkRemotely: wwr,
};

/** Runs every board; returns the jobs plus a per-board status line for the report. */
export async function fetchBoards(): Promise<{ jobs: Job[]; status: Record<string, string> }> {
  const status: Record<string, string> = {};
  const results = await Promise.all(
    Object.entries(BOARDS).map(async ([name, fn]) => {
      try {
        const jobs = (await fn()).filter((j) => j.title && j.url);
        status[name] = `${jobs.length} jobs`;
        return jobs;
      } catch (err) {
        status[name] = `failed: ${(err as Error).message}`;
        return [];
      }
    }),
  );
  return { jobs: results.flat(), status };
}
