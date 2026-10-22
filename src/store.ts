/** data/seen.json remembers every posting already scored, so each job is reported once. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FILE = "data/seen.json";
const KEEP_DAYS = 90;

export type Seen = Record<string, { at: string; title: string; score?: number }>;

export function loadSeen(): Seen {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Seen;
  } catch {
    return {};
  }
}

export function saveSeen(seen: Seen): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const pruned = Object.fromEntries(Object.entries(seen).filter(([, v]) => Date.parse(v.at) >= cutoff));
  mkdirSync("data", { recursive: true });
  writeFileSync(FILE, JSON.stringify(pruned, null, 1) + "\n");
}
