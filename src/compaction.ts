import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type CompactionPlan =
  | { action: "none" }
  | { action: "compact"; older: ChatMessage[]; recent: ChatMessage[] };

/** Rough estimate (about 4 characters per token). Enough to decide when to compact. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const plan = (
  summary: string | null,
  messages: ChatMessage[],
  limits: { budgetTokens: number; keepRecent: number }
): CompactionPlan => {
  const total = estimateTokens(summary ?? "") + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= limits.budgetTokens || messages.length <= limits.keepRecent) return { action: "none" };
  const cut = messages.length - limits.keepRecent;
  return { action: "compact", older: messages.slice(0, cut), recent: messages.slice(cut) };
};

const SUMMARY_INSTRUCTIONS = `
Compress this chat between Deepanshu and his job search agent Gideon into a short briefing for Gideon's next turns.
Keep: roles and companies discussed, decisions made, preferences he stated, facts he gave, what was sent or submitted, anything still open.
Drop: pleasantries, raw job listings, and anything already finished that he will not come back to.
Plain text, under 300 words. Merge the previous summary in. Do not invent details.
`;

/** Summaries are easy work, so SUMMARY_MODEL can name a cheaper model. Falls back to the chat model. */
const summaryModel = () => openai(process.env.SUMMARY_MODEL ?? "gpt-6-luna");

const summarize = async (previous: string | null, older: ChatMessage[]) => {
  const transcript = older.map((m) => `${m.role === "user" ? "Deepanshu" : "Gideon"}: ${m.content}`).join("\n\n");
  const { text } = await generateText({
    model: summaryModel(),
    instructions: SUMMARY_INSTRUCTIONS,
    messages: [{ role: "user", content: `${previous ? `PREVIOUS SUMMARY:\n${previous}\n\n` : ""}NEW MESSAGES:\n${transcript}` }]
  });
  return text.trim();
};

export const Compaction = { plan, summarize } as const;
