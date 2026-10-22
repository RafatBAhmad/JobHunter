/** Telegram digest + a Markdown report per run (committed to reports/ and shown in the Actions summary). */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Scored } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mdCell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

export function telegramText(date: string, top: Scored[], stats: string): string[] {
  if (top.length === 0) return [`🔎 <b>${date}</b>\nلا وظائف جديدة مناسبة اليوم.\n<i>${esc(stats)}</i>`];
  const blocks = top.map((j, i) => {
    const lines = [
      `<b>${i + 1}. ${esc(j.title)}</b> — ${esc(j.company || "?")}`,
      `⭐ ${j.score}/100 · 📍 ${esc(j.location)} · ${esc(j.source)}`,
      j.salary ? `💰 ${esc(j.salary)}` : "",
      `✅ ${esc(j.fit_reasons)}`,
      `🛂 ${esc(j.eligibility_reason)}`,
      j.red_flags ? `⚠️ ${esc(j.red_flags)}` : "",
      `🔗 ${esc(j.url)}`,
    ];
    return lines.filter(Boolean).join("\n");
  });
  const header = `🔎 <b>وظائف جديدة مناسبة — ${date}</b>\n<i>${esc(stats)}</i>`;
  // Telegram caps a message at 4096 characters; split on job boundaries.
  const chunks: string[] = [];
  let current = header;
  for (const b of blocks) {
    if ((current + "\n\n" + b).length > 3900) {
      chunks.push(current);
      current = b;
    } else current += "\n\n" + b;
  }
  chunks.push(current);
  return chunks;
}

export async function sendTelegram(chunks: string[]): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return "Telegram skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)";
  for (const text of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `Telegram failed: HTTP ${res.status} ${await res.text()}`;
  }
  return `Telegram sent (${chunks.length} message${chunks.length > 1 ? "s" : ""})`;
}

export function writeReport(date: string, scored: Scored[], minScore: number, meta: string[]): string {
  const top = scored.filter((j) => j.score >= minScore);
  const maybe = scored.filter((j) => j.score >= 50 && j.score < minScore);
  const md: string[] = [`# وظائف ${date}`, "", ...meta.map((m) => `- ${m}`), ""];

  md.push(`## الأنسب (${top.length})`, "");
  if (!top.length) md.push("لا شيء فوق الحد اليوم.", "");
  for (const j of top) {
    md.push(
      `### ${j.score} · [${j.title}](${j.url}) — ${j.company}`,
      "",
      `- **المكان**: ${j.location} · **المصدر**: ${j.source}${j.salary ? ` · **الراتب**: ${j.salary}` : ""}`,
      `- **لماذا تناسبك**: ${j.fit_reasons}`,
      `- **الأهلية**: ${j.eligibility_reason}`,
      j.red_flags ? `- **تنبيه**: ${j.red_flags}` : "",
      j.pitch ? `\n> ${j.pitch}` : "",
      "",
    );
  }

  if (maybe.length) {
    md.push(`## ربما (${maybe.length})`, "", "| الدرجة | الوظيفة | الشركة | المكان |", "|---|---|---|---|");
    for (const j of maybe) md.push(`| ${j.score} | [${mdCell(j.title)}](${j.url}) | ${mdCell(j.company)} | ${mdCell(j.location)} |`);
    md.push("");
  }

  const text = md.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  mkdirSync("reports", { recursive: true });
  const file = `reports/${date}.md`;
  writeFileSync(file, text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  return file;
}
