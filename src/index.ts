/**
 * Daily run:  fetch boards (+ web search on chosen weekdays) -> drop already-seen ->
 * keyword prefilter -> Claude scoring -> Telegram digest + Markdown report.
 *
 *   npm run hunt            full run (needs ANTHROPIC_API_KEY; Telegram optional)
 *   npm run dry-run         offline: fixtures + heuristic scores, prints the digest
 *   npm run check-sources   fetches every board and prints counts, no model calls
 */
import { readFileSync, readdirSync } from "node:fs";
import { usage, MODEL } from "./claude.js";
import { sendTelegram, telegramText, writeReport } from "./notify.js";
import { prefilter } from "./prefilter.js";
import { scoreJobs } from "./score.js";
import { fetchBoards, mapHimalayas, mapJobicy, mapRemoteOk, mapRemotive, mapWwr } from "./sources/boards.js";
import { searchWeb } from "./sources/websearch.js";
import { loadSeen, saveSeen } from "./store.js";
import type { Job, Profile, Scored } from "./types.js";
import { dedupeKey } from "./util.js";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const env = (k: string, d: string) => process.env[k]?.trim() || d;
const MIN_SCORE = Number(env("MIN_SCORE", "70"));
const MAX_ALERTS = Number(env("MAX_ALERTS", "10"));
const MAX_SCORE_JOBS = Number(env("MAX_SCORE_JOBS", "120"));
const WEB_SEARCH_DAYS = env("WEB_SEARCH_DAYS", "1,4"); // 0=Sun … 6=Sat, "all" or "never"

const profile = JSON.parse(readFileSync("profile.json", "utf8")) as Profile;
const today = new Date().toISOString().slice(0, 10);

function webSearchToday(): boolean {
  if (args.has("--no-web") || WEB_SEARCH_DAYS === "never") return false;
  if (args.has("--web") || WEB_SEARCH_DAYS === "all") return true;
  return WEB_SEARCH_DAYS.split(",").map(Number).includes(new Date().getUTCDay());
}

function loadFixtures(): Job[] {
  const read = (f: string) => readFileSync(`fixtures/${f}`, "utf8");
  const files = readdirSync("fixtures");
  const out: Job[] = [];
  for (const f of files) {
    if (f.startsWith("remotive")) out.push(...mapRemotive(JSON.parse(read(f))));
    else if (f.startsWith("remoteok")) out.push(...mapRemoteOk(JSON.parse(read(f))));
    else if (f.startsWith("himalayas")) out.push(...mapHimalayas(JSON.parse(read(f))));
    else if (f.startsWith("jobicy")) out.push(...mapJobicy(JSON.parse(read(f))));
    else if (f.startsWith("wwr")) out.push(...mapWwr(read(f)));
  }
  return out;
}

/** Offline stand-in for the model so the pipeline and report can be tested without an API key. */
function heuristicScore(jobs: Job[]): Scored[] {
  return jobs
    .map((j) => {
      const hay = `${j.title} ${j.tags.join(" ")} ${j.description}`.toLowerCase();
      const hits = ["flutter", "nestjs", "node", "typescript", "next.js", "spring", "postgres", "react"].filter((k) => hay.includes(k));
      const score = Math.min(95, 40 + hits.length * 12);
      return { ...j, score, eligible: "unclear" as const, eligibility_reason: "(تجريبي) لم يُقيَّم بالنموذج", fit_reasons: `(تجريبي) كلمات مطابقة: ${hits.join(", ") || "لا شيء"}`, red_flags: "", pitch: "" };
    })
    .sort((a, b) => b.score - a.score);
}

function costUsd(): number {
  // Claude Opus 5.5 list prices per 1M tokens; web search $10 per 1,000 searches.
  const p = MODEL.startsWith("claude-haiku-5-5") ? { i: 0.1, o: 0.5 } : MODEL.startsWith("claude-sonnet") ? { i: 2, o: 10 } : { i: 4, o: 20 };
  return (usage.input * p.i + usage.output * p.o + usage.cacheRead * p.i * 0.05 + usage.cacheWrite * p.i * 1.25) / 1e6 + usage.webSearches * 0.01;
}

async function main(): Promise<void> {
  if (args.has("--check-sources")) {
    const { jobs, status } = await fetchBoards();
    console.table(status);
    console.log(`total ${jobs.length}; after prefilter ${prefilter(jobs).kept.length}`);
    return;
  }

  const seen = loadSeen();
  const meta: string[] = [];

  // 1. Collect
  let jobs: Job[];
  if (DRY) {
    jobs = loadFixtures();
    meta.push(`وضع تجريبي: ${jobs.length} وظيفة من ملفات fixtures`);
  } else {
    const boards = await fetchBoards();
    jobs = boards.jobs;
    meta.push(`المصادر: ${Object.entries(boards.status).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    if (webSearchToday()) {
      const recentWeb = Object.entries(seen).filter(([k]) => k.startsWith("web:")).map(([, v]) => v.title);
      try {
        const web = await searchWeb(profile, recentWeb);
        jobs.push(...web.jobs);
        meta.push(`بحث الويب: ${web.note}`);
      } catch (err) {
        meta.push(`بحث الويب فشل: ${(err as Error).message}`);
      }
    } else meta.push("بحث الويب: ليس من أيامه اليوم");
  }

  // 2. De-duplicate (same posting on several boards, or already reported)
  const fresh: Job[] = [];
  const keys = new Set<string>();
  for (const j of jobs) {
    const k = `k:${dedupeKey(j.title, j.company)}`;
    if (seen[j.id] || seen[k] || keys.has(k)) continue;
    keys.add(k);
    fresh.push(j);
  }

  // 3. Prefilter, newest first, capped to bound cost
  const { kept, dropped } = prefilter(fresh, DRY ? Infinity : 21); // fixtures have fixed dates
  kept.sort((a, b) => (Date.parse(b.postedAt ?? "") || 0) - (Date.parse(a.postedAt ?? "") || 0));
  const toScore = kept.slice(0, MAX_SCORE_JOBS);
  meta.push(`جديد: ${fresh.length} · بعد الفلترة: ${kept.length} (استُبعد ${dropped}) · أُرسل للتقييم: ${toScore.length}`);

  // 4. Score
  let scored: Scored[] = [];
  if (DRY) scored = heuristicScore(toScore);
  else if (toScore.length) {
    const r = await scoreJobs(profile, toScore);
    scored = r.scored;
    if (r.errors.length) meta.push(`أخطاء التقييم: ${r.errors.join("; ")}`);
  }

  // 5. Remember what was scored (by id and by company|title)
  if (!DRY) {
    for (const j of scored) {
      seen[j.id] = { at: today, title: `${j.title} — ${j.company}`, score: j.score };
      seen[`k:${dedupeKey(j.title, j.company)}`] = { at: today, title: j.title };
    }
    saveSeen(seen);
  }

  // 6. Report + Telegram
  if (!DRY) meta.push(`النموذج: ${MODEL} · التكلفة التقديرية لهذا التشغيل: $${costUsd().toFixed(2)} (${usage.webSearches} عملية بحث)`);
  const file = writeReport(DRY ? `${today}-dry-run` : today, scored, MIN_SCORE, meta);
  const top = scored.filter((j) => j.score >= MIN_SCORE).slice(0, MAX_ALERTS);
  const stats = `${scored.length} وظيفة قُيّمت · ${top.length} فوق ${MIN_SCORE}`;
  const chunks = telegramText(today, top, stats);

  if (DRY) {
    console.log(chunks.join("\n\n──────── message break ────────\n\n"));
    console.log(`\nreport: ${file}`);
  } else {
    console.log(await sendTelegram(chunks));
    console.log(`report: ${file}`);
  }
  console.log(meta.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
