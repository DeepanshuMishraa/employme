import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Applications } from "./applications";
import { Browser, type Field } from "./browser";
import { Form, type PlanField, type Question } from "./form";
import { Gmail } from "./gmail";
import { Profile } from "./profile";
import { Result } from "./result";
import { Resume } from "./resume";

const SCREENSHOT_DIR = "data/screens";
const JOB_TEXT_CHARS = 4_000;
const CODE_WAIT_MS = 90_000;
const SETTLE_MS = 5_000;
const NON_FORM_LABEL = /^(enter manually|security code|verification code)$|i am human|captcha|not a robot/i;
const CODE_BOX = /security code|verification code/i;
const UPLOAD_FAILURE = /cannot read properties|upload failed|failed to upload/i;
const CONFIRMATION_TEXT = /thank you for applying|application (has been )?(received|submitted)|successfully submitted/i;
const CONFIRMATION_URL = /confirmation|thank-?you|submitted/i;

/**
 * What to click to reveal a form, most specific first. A bare "Apply" is only trusted as a button:
 * as a link it is usually site navigation (on YC it leads to the batch application, not the job).
 */
const APPLY_TARGETS: [RegExp, readonly string[]][] = [
  [/^apply (to|for) (this )?(role|job|position)/i, ["button", "link"]],
  [/^apply now/i, ["button", "link"]],
  [/^apply$/i, ["button"]]
];

export type PrepareResult =
  | { status: "needs_input"; id: number; questions: Question[] }
  | { status: "ready"; id: number; filled: { label: string; value: string; generated: boolean }[]; unfilled: string[]; notes: string[]; screenshot: string }
  | { status: "already_submitted"; id: number }
  | { status: "failed"; error: string };

export type SubmitResult =
  | { status: "submitted"; id: number; confirmationUrl: string }
  | { status: "needs_code"; id: number; message: string }
  | { status: "needs_human"; id: number; problems: string[]; screenshot: string }
  | { status: "failed"; error: string };

/** The browser holds one open form at a time, so only one application can wait for approval. */
let active: { id: number; url: string } | null = null;

const dailyCap = () => Number(process.env.MAX_APPLICATIONS_PER_DAY ?? 10);

/** Keeps headings and prose from the page and drops form chrome, for context on the role. */
const readableText = (snapshot: string) =>
  snapshot
    .split("\n")
    .flatMap((line) => /^\s*- (?:StaticText|heading) "(.*?)"(?: \[|$|:)/.exec(line)?.[1] ?? [])
    .join("\n")
    .slice(0, JOB_TEXT_CHARS);

const readFields = async (): Promise<Result<Field[]>> => {
  const fields = await Browser.fields();
  return fields.ok ? Result.ok(fields.value.filter((field) => !NON_FORM_LABEL.test(field.label))) : fields;
};

/** Some job pages show a description first and reveal the form behind an Apply button. */
const readFormFields = async (): Promise<Result<Field[]>> => {
  const first = await readFields();
  if (!first.ok || first.value.length > 0) return first;
  for (const [name, roles] of APPLY_TARGETS) {
    const clicked = await Browser.clickButton(name, roles);
    if (!clicked.ok) continue;
    await Browser.wait(2000);
    return readFields();
  }
  return first;
};

const attachResume = async (pdf: Result<string>, resumeText: string) => {
  if (pdf.ok) {
    const uploaded = await Browser.upload("input[type=file]", pdf.value);
    if (uploaded.ok) {
      await Browser.wait(1500);
      if (!UPLOAD_FAILURE.test(await Browser.text())) return "Resume file uploaded.";
    }
  }
  const manual = await Browser.clickButton(/enter manually/i);
  if (!manual.ok) return "Could not attach a resume: no working upload and no manual entry option. Check the form.";
  const pasted = await Browser.fill("Enter manually", 0, resumeText);
  return pasted.ok
    ? "The site rejected the resume file upload, so the resume text was pasted instead."
    : `Could not attach a resume: ${pasted.error}`;
};

const classify = async (): Promise<"confirmed" | "needs_code" | "unknown"> => {
  const [url, text] = await Promise.all([Browser.url(), Browser.text()]);
  if (CONFIRMATION_URL.test(url) || CONFIRMATION_TEXT.test(text)) return "confirmed";
  if (/verification code was sent|security code/i.test(text)) return "needs_code";
  return "unknown";
};

const screenshot = async (id: number) => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const path = resolve(SCREENSHOT_DIR, `${id}.png`);
  await Browser.screenshot(path);
  return path;
};

const abandon = async (id: number, error: string): Promise<{ status: "failed"; error: string }> => {
  Applications.update(id, "failed", error);
  await Browser.close();
  active = null;
  return { status: "failed", error };
};

const prepare = async (url: string, turnId: string): Promise<PrepareResult> => {
  const row = Applications.begin(url, "");
  if (!row) return { status: "failed", error: "Could not record the application in the local database." };
  if (row.status === "submitted") return { status: "already_submitted", id: row.id };
  active = null;

  const [profile, resumeText, pdf] = await Promise.all([Profile.load(), Resume.text(), Resume.pdf()]);

  const opened = await Browser.open(url);
  if (!opened.ok) return abandon(row.id, `Could not open the page: ${opened.error}`);

  const found = await readFormFields();
  if (!found.ok) return abandon(row.id, found.error);
  if (found.value.length === 0) {
    return abandon(row.id, "No form fields found. The page may be a job description without an inline form, or the form may need a login first. Try the direct application link.");
  }

  const planFields: PlanField[] = [];
  for (const [id, field] of found.value.entries()) {
    if (field.kind !== "select") {
      planFields.push({ ...field, id });
      continue;
    }
    const listed = await Browser.options(field.label, field.ordinal);
    const options = listed.ok && listed.value.length > 0 && listed.value.length <= Form.MAX_LISTED_OPTIONS ? listed.value : null;
    planFields.push({ ...field, id, options });
  }

  const [title, pageText] = await Promise.all([Browser.title(), Browser.text()]);
  const plan = await Form.plan({
    fields: planFields,
    profile,
    job: { url, title, text: readableText(pageText) },
    resume: resumeText
  }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (plan instanceof Error) return abandon(row.id, `Could not plan the answers: ${plan.message}`);

  if (plan.questions.length > 0) {
    Applications.update(row.id, "needs_input", plan.questions.map((question) => question.profileKey).join(", "));
    await Browser.close();
    return { status: "needs_input", id: row.id, questions: plan.questions };
  }

  // Planning takes a while. If the browser lost the form meanwhile (crash, redirect), stop instead of failing every field.
  const stillThere = await readFields();
  if (!stillThere.ok || stillThere.value.length < found.value.length / 2) {
    return abandon(row.id, "The browser lost the application form while the answers were being planned. Nothing was submitted. Run prepare_application again.");
  }

  const filled: { label: string; value: string; generated: boolean }[] = [];
  const notes: string[] = [];
  for (const { field, value, generated } of plan.answers) {
    if (field.kind === "text") {
      const done = await Browser.fill(field.label, field.ordinal, value);
      if (done.ok) filled.push({ label: field.label, value, generated });
      else notes.push(`Could not fill "${field.label}": ${done.error}`);
    } else if (field.kind === "select" || field.kind === "choice") {
      const done = field.kind === "select" ? await Browser.pick(field.label, field.ordinal, value) : await Browser.pickChoice(field.label, field.ordinal, value);
      if (done.ok) filled.push({ label: field.label, value: done.value, generated });
      else notes.push(done.error);
    } else {
      const done = await Browser.setChecked(field.label, field.ordinal, /^(yes|true|agree|checked)/i.test(value));
      if (done.ok) filled.push({ label: field.label, value, generated });
      else notes.push(`Could not set "${field.label}": ${done.error}`);
    }
  }
  notes.push(await attachResume(pdf, resumeText));

  const after = await readFields();
  const answered = new Set(filled.map((entry) => entry.label));
  const emptyNow = new Set(after.ok ? after.value.filter((field) => field.kind === "text" && !field.value).map((field) => field.label) : []);
  const unfilled = found.value
    .filter((field) => field.required && (!answered.has(field.label) || emptyNow.has(field.label)))
    .map((field) => field.label);

  Applications.update(row.id, "prepared", `${filled.length} fields filled`, turnId);
  active = { id: row.id, url };
  return { status: "ready", id: row.id, filled, unfilled, notes, screenshot: await screenshot(row.id) };
};

const submit = async (id: number, turnId: string, securityCode?: string): Promise<SubmitResult> => {
  const application = Applications.get(id);
  if (!application) return { status: "failed", error: `No application with id ${id}.` };
  if (application.status === "submitted") return { status: "failed", error: "Already submitted. Nothing was sent again." };
  if (application.status !== "prepared") return { status: "failed", error: `Application ${id} is "${application.status}", not ready to submit. Run prepare_application again.` };
  if (application.preparedTurn === turnId) {
    return { status: "failed", error: "Approval required. Show the user the filled form and wait for their go-ahead in a new message before submitting. Nothing was submitted." };
  }
  if (active?.id !== id) return { status: "failed", error: "The browser session for this form is gone (restart or another application replaced it). Run prepare_application again. Nothing was submitted." };
  if (Applications.submittedToday() >= dailyCap()) return { status: "failed", error: `Daily cap of ${dailyCap()} applications reached. Nothing was submitted.` };

  const startedAt = new Date();
  const clickSubmit = () => Browser.clickButton(/^submit/i);

  if (securityCode) {
    const typed = await Browser.typeInto(CODE_BOX, securityCode);
    if (!typed.ok) return { status: "failed", error: typed.error };
  }
  const clicked = await clickSubmit();
  if (!clicked.ok) return { status: "failed", error: clicked.error };
  await Browser.wait(SETTLE_MS);
  let state = await classify();

  if (state === "needs_code" && !securityCode) {
    if (!(await Gmail.isConnected())) {
      return { status: "needs_code", id, message: "The site emailed a verification code. Ask the user for it, then call submit_application again with securityCode." };
    }
    const code = await Gmail.waitForCode(startedAt, CODE_WAIT_MS);
    if (!code.ok) return { status: "needs_code", id, message: code.error };
    const typed = await Browser.typeInto(CODE_BOX, code.value);
    if (!typed.ok) return { status: "failed", error: typed.error };
    const resubmitted = await clickSubmit();
    if (!resubmitted.ok) return { status: "failed", error: resubmitted.error };
    await Browser.wait(SETTLE_MS);
    state = await classify();
  }

  if (state === "confirmed") {
    const confirmationUrl = await Browser.url();
    Applications.update(id, "submitted", confirmationUrl);
    await Browser.close();
    active = null;
    return { status: "submitted", id, confirmationUrl };
  }

  const text = await Browser.text();
  const problems = [...new Set(text.split("\n").flatMap((line) => /"([^"]*(?:required|invalid|error|captcha|verify|try again|incorrect)[^"]*)"/i.exec(line)?.[1] ?? []))].slice(0, 8);
  const shot = await screenshot(id);
  Applications.update(id, "needs_human", problems.join(" | "));
  await Browser.close();
  active = null;
  return { status: "needs_human", id, problems, screenshot: shot };
};

/** The application whose filled form is still open in the browser and can be submitted, if any. */
const activeApplication = () => active;

export const Apply = { prepare, submit, activeApplication } as const;
