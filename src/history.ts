import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { Compaction, type ChatMessage } from "./compaction";

mkdirSync("data", { recursive: true });
const db = new Database("data/history.db");
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL
  )
`);
db.run(`CREATE TABLE IF NOT EXISTS summary (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL)`);

const BUDGET_TOKENS = 20_000;
const KEEP_RECENT = 6;

const MessageRow = z.object({ id: z.number(), role: z.enum(["user", "assistant"]), content: z.string() });
const SummaryRow = z.object({ text: z.string() });

const readSummary = () => {
  const parsed = SummaryRow.safeParse(db.query("SELECT text FROM summary WHERE id = 1").get());
  return parsed.success ? parsed.data.text : null;
};

const readMessages = () =>
  db
    .query("SELECT id, role, content FROM messages ORDER BY id")
    .all()
    .flatMap((row) => {
      const parsed = MessageRow.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });

/** Compaction runs after the reply is sent. `load` waits for it so a turn never reads half-compacted history. */
let compacting: Promise<void> = Promise.resolve();

const compact = async () => {
  const summary = readSummary();
  const rows = readMessages();
  const plan = Compaction.plan(summary, rows, { budgetTokens: BUDGET_TOKENS, keepRecent: KEEP_RECENT });
  if (plan.action === "none") return;

  const lastOlder = rows[plan.older.length - 1];
  if (!lastOlder) return;
  const next = await Compaction.summarize(summary, plan.older);
  if (next.length === 0) return;

  db.transaction(() => {
    db.query("INSERT INTO summary (id, text) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text").run(next);
    db.query("DELETE FROM messages WHERE id <= ?").run(lastOlder.id);
  })();
};

/**
 * Chat turns kept across messages. Only user and assistant text is stored, never tool results, so
 * bulky search and form output is dropped by construction. Older turns are folded into one summary.
 */
export const History = {
  load: async () => {
    await compacting;
    const messages: ChatMessage[] = readMessages().map(({ role, content }) => ({ role, content }));
    return { summary: readSummary(), messages };
  },

  append: (role: ChatMessage["role"], content: string) => {
    db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run(role, content);
  },

  /** Failure leaves history and the old summary intact, so the next turn retries. */
  compactInBackground: () => {
    compacting = compacting.then(compact).catch((err) => {
      console.error("History compaction failed; history is unchanged and will be retried next turn", err);
    });
  }
} as const;
