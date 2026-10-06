import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { z } from "zod";

mkdirSync("data", { recursive: true });
const db = new Database("data/applications.db");
db.run(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_turn TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const RowSchema = z.object({
  id: z.string(),
  to_addr: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(["pending", "sent", "discarded"]),
  created_turn: z.string()
});

export type Draft = { id: string; to: string; subject: string; body: string; createdTurn: string };

const toDraft = (row: unknown): Draft | null => {
  const parsed = RowSchema.safeParse(row);
  return parsed.success
    ? { id: parsed.data.id, to: parsed.data.to_addr, subject: parsed.data.subject, body: parsed.data.body, createdTurn: parsed.data.created_turn }
    : null;
};

/** Email drafts waiting for the user's decision. Stored so a later message can act on them. */
export const Drafts = {
  add: (draft: Draft) => {
    db.query("INSERT INTO drafts (id, to_addr, subject, body, created_turn) VALUES (?, ?, ?, ?, ?)").run(draft.id, draft.to, draft.subject, draft.body, draft.createdTurn);
  },

  /** The draft the user is most likely answering: the newest one still pending. */
  latestPending: () => toDraft(db.query("SELECT * FROM drafts WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()),

  get: (id: string) => toDraft(db.query("SELECT * FROM drafts WHERE id = ? AND status = 'pending'").get(id)),

  pendingIds: () =>
    db
      .query("SELECT id FROM drafts WHERE status = 'pending'")
      .all()
      .flatMap((row) => {
        const parsed = z.object({ id: z.string() }).safeParse(row);
        return parsed.success ? [parsed.data.id] : [];
      }),

  markSent: (id: string) => {
    db.query("UPDATE drafts SET status = 'sent' WHERE id = ?").run(id);
  },

  markDiscarded: (id: string) => {
    db.query("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(id);
  }
} as const;
