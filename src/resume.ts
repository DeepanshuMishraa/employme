import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Browser } from "./browser";
import { Result } from "./result";

const RESUME_MD = "refs/resume.md";
const HTML_PATH = "data/resume.html";
const PDF_PATH = "data/resume.pdf";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const inline = (text: string) =>
  escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>");

/** Small Markdown subset: headings, bullets, bold, italics, paragraphs. Enough for refs/resume.md. */
const toHtml = (markdown: string) => {
  const body = markdown
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading?.[1]) return `<h${heading[1].length}>${inline(heading[2] ?? "")}</h${heading[1].length}>`;
      const bullet = /^-\s+(.*)$/.exec(line);
      if (bullet) return `<li>${inline(bullet[1] ?? "")}</li>`;
      return line.trim() ? `<p>${inline(line)}</p>` : "";
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:10.5px;line-height:1.35;margin:28px 36px;color:#111}
    h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 4px;border-bottom:1px solid #999}
    h3{font-size:11.5px;margin:8px 0 2px}p{margin:2px 0}li{margin:1px 0 1px 16px}
  </style>${body}`;
};

export const Resume = {
  text: () => readFile(RESUME_MD, "utf8"),

  /** Renders refs/resume.md to a PDF once and reuses it until the Markdown changes. */
  pdf: async (): Promise<Result<string>> => {
    const [source, existing] = await Promise.all([stat(RESUME_MD), stat(PDF_PATH).catch(() => null)]);
    const target = resolve(PDF_PATH);
    if (existing && existing.mtimeMs > source.mtimeMs) return Result.ok(target);
    await mkdir("data", { recursive: true });
    await writeFile(HTML_PATH, toHtml(await Resume.text()), "utf8");
    const opened = await Browser.open(`file://${resolve(HTML_PATH)}`);
    if (!opened.ok) return opened;
    const printed = await Browser.pdf(target);
    return printed.ok ? Result.ok(target) : printed;
  }
} as const;

export const ResumeParsing = { toHtml } as const;
