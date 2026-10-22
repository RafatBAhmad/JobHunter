/**
 * Cheap keyword pass before any model call: drops roles that are obviously off-stack,
 * obviously country-locked, junior, or stale. Anything borderline goes through to
 * the model, which makes the real decision.
 */
import type { Job } from "./types.js";
import { daysAgo } from "./util.js";

const STACK = [
  "flutter", "dart", "node", "nodejs", "node.js", "nest", "nestjs", "typescript", "javascript", "next.js", "nextjs",
  "react", "full stack", "full-stack", "fullstack", "backend", "back-end", "back end", "java", "spring", "kotlin",
  "postgres", "api", "software engineer", "software developer", "mobile", "web developer",
];

const OFF_ROLE = [
  "sales", "account executive", "marketing", "recruiter", "designer", "customer support", "support specialist",
  "data scientist", "machine learning researcher", "intern", "internship", "graduate program", "junior", "trainee",
  "writer", "copywriter", "accountant", "virtual assistant", "embedded", "firmware", "unity", "unreal", "solidity",
  "php developer", "wordpress", "ruby on rails", ".net developer", "c# developer", "golang", "rust engineer", "ios developer",
];

const escapeRe = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OFF_ROLE_RE = new RegExp(`(^|[^a-z])(${OFF_ROLE.map(escapeRe).join("|")})([^a-z]|$)`, "i");

const LOCKED = [
  /\b(us|usa|u\.s\.|united states)[- ]?(only|based|residents?|citizens?)\b/i,
  /\bmust (be|reside|live) (located |based )?in the (us|usa|united states|uk|united kingdom|eu|european union)\b/i,
  /\b(uk|canada|australia|india|brazil|latam|germany|poland|philippines|europe|eu)[- ]?only\b/i,
  /\bsecurity clearance\b/i,
  /\bauthori[sz]ed to work in the (us|united states|uk)\b/i,
];

const LOCATION_LOCKED = /^(usa?|united states|canada|uk|united kingdom|latam|latin america|brazil|india|philippines|australia|germany|poland|americas|north america)( only)?$/i;

export function prefilter(jobs: Job[], maxAgeDays = 21): { kept: Job[]; dropped: number } {
  const kept = jobs.filter((j) => {
    if (j.source === "Web search") return true; // already targeted; let the model judge
    const title = j.title.toLowerCase();
    const hay = `${title} ${j.tags.join(" ").toLowerCase()} ${j.description.slice(0, 600).toLowerCase()}`;
    if (!STACK.some((k) => hay.includes(k))) return false;
    if (OFF_ROLE_RE.test(title)) return false;
    if (LOCATION_LOCKED.test(j.location.trim())) return false;
    if (LOCKED.some((re) => re.test(`${j.location} ${j.description}`))) return false;
    const age = daysAgo(j.postedAt);
    if (age !== null && age > maxAgeDays) return false;
    return true;
  });
  return { kept, dropped: jobs.length - kept.length };
}
