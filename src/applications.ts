import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { z } from "zod";

mkdirSync("data", { recursive: true });
const db = new Database("data/applications.db");
db.run(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    prepared_turn TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export const ApplicationStatusSchema = z.enum(["preparing", "needs_input", "prepared", "submitted", "needs_human", "failed"]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

const RowSchema = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  status: ApplicationStatusSchema,
  note: z.string(),
  prepared_turn: z.string().nullable(),
  updated_at: z.string()
});

export type Application = {
  id: number;
  url: string;
  title: string;
  status: ApplicationStatus;
  note: string;
  preparedTurn: string | null;
  updatedAt: string;
};

const toApplication = (row: unknown): Application | null => {
  const parsed = RowSchema.safeParse(row);
  if (!parsed.success) return null;
  const { prepared_turn, updated_at, ...rest } = parsed.data;
  return { ...rest, preparedTurn: prepared_turn, updatedAt: updated_at };
};

export const Applications = {
  get: (id: number) => toApplication(db.query("SELECT * FROM applications WHERE id = ?").get(id)),

  byUrl: (url: string) => toApplication(db.query("SELECT * FROM applications WHERE url = ?").get(url)),

  list: (limit = 20) =>
    db
      .query("SELECT * FROM applications ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit)
      .flatMap((row) => {
        const application = toApplication(row);
        return application ? [application] : [];
      }),

  /** Creates the row for a URL, or resets an unfinished one. A submitted application is never reopened. */
  begin: (url: string, title: string): Application | null => {
    const existing = Applications.byUrl(url);
    if (existing?.status === "submitted") return existing;
    db.query(
      `INSERT INTO applications (url, title, status) VALUES (?, ?, 'preparing')
       ON CONFLICT(url) DO UPDATE SET title = excluded.title, status = 'preparing', note = '', prepared_turn = NULL, updated_at = datetime('now')`
    ).run(url, title);
    return Applications.byUrl(url);
  },

  update: (id: number, status: ApplicationStatus, note = "", preparedTurn: string | null = null) => {
    db.query("UPDATE applications SET status = ?, note = ?, prepared_turn = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      note,
      preparedTurn,
      id
    );
  },

  submittedToday: () => {
    const row = z
      .object({ count: z.number() })
      .parse(db.query("SELECT COUNT(*) AS count FROM applications WHERE status = 'submitted' AND date(updated_at) = date('now')").get());
    return row.count;
  }
} as const;
