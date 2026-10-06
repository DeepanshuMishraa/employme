import { describe, expect, it } from "vitest";
import { BrowserParsing } from "./browser";
import { Form, type PlanField } from "./form";
import { GmailParsing } from "./gmail";
import { Profile } from "./profile";
import { ResumeParsing } from "./resume";
import { Writing } from "./writing";

const SNAPSHOT = `
- heading "Apply for this job" [level=2, ref=e14]
- textbox "First Name" [required, ref=e22]: Deepanshu
- combobox "Country" [expanded=false, ref=e66]
- button "Toggle flyout" [ref=e68]
- button "Attach" [ref=e26]: resume.pdf
- combobox "Have you ever interviewed at Anthropic before?" [expanded=false, required, ref=e52]
- textbox "Notes \\"quoted\\"" [ref=e30]
- textbox "Notes" [ref=e31]
- textbox "Notes" [ref=e32]
- listbox [ref=e34]
  - option "Yes" [ref=e47]
  - option "No" [ref=e48]
`;

describe("parseSnapshot", () => {
  const nodes = BrowserParsing.parseSnapshot(SNAPSHOT);

  it("reads role, name, attrs, ref and value", () => {
    expect(nodes.find((node) => node.name === "First Name")).toEqual({
      role: "textbox",
      name: "First Name",
      attrs: ["required", "ref=e22"],
      ref: "e22",
      value: "Deepanshu",
      depth: 0
    });
  });

  it("handles nodes without a name and escaped quotes", () => {
    expect(nodes.find((node) => node.role === "listbox")?.ref).toBe("e34");
    expect(nodes.some((node) => node.name === 'Notes "quoted"')).toBe(true);
  });

  it("builds fields, skipping chrome and numbering repeated labels", () => {
    const fields = BrowserParsing.toFields(nodes);
    expect(fields.map((field) => field.label)).not.toContain("Toggle flyout");
    expect(fields.find((field) => field.label === "First Name")).toMatchObject({ kind: "text", required: true, value: "Deepanshu" });
    expect(fields.find((field) => field.label === "Country")?.kind).toBe("select");
    expect(fields.filter((field) => field.label === "Notes").map((field) => field.ordinal)).toEqual([0, 1]);
  });
});

/** Trimmed from a real Ashby application page: Yes/No button rows and an unnamed radio pair. */
const ASHBY = `
- tabpanel "Application" [ref=e8]
  - generic
    - StaticText "Check Yes or No to agree to text message updates."
    - LabelText
      - radio "Yes - I consent to receiving text messages" [checked=false, ref=e33]
      - strong
        - StaticText "Yes"
    - LabelText
      - radio "No - I do not consent to receiving text messages" [checked=false, ref=e34]
      - strong
        - StaticText "No"
    - LabelText
      - StaticText "LinkedIn Profile"
    - textbox "LinkedIn Profile" [ref=e19]
    - LabelText
      - StaticText "Are you currently authorized to work in the U.S.?"
      - StaticText "*"
    - generic
      - button "Yes" [ref=e35]
      - button "No" [ref=e36]
    - LabelText
      - StaticText "Have you built production apps?"
      - StaticText "*"
    - generic
      - button "Yes" [ref=e37]
      - button "No" [ref=e38]
    - LabelText
      - StaticText "Optional extra"
    - generic
      - button "Upload File" [ref=e18]
`;

describe("choice groups", () => {
  const fields = BrowserParsing.toChoiceFields(BrowserParsing.parseSnapshot(ASHBY));

  it("finds Yes/No button rows with their question and required marker", () => {
    const authorized = fields.find((field) => field.label.startsWith("Are you currently authorized"));
    expect(authorized).toMatchObject({ kind: "choice", required: true, options: ["Yes", "No"] });
    expect(fields.find((field) => field.label.startsWith("Have you built"))?.options).toEqual(["Yes", "No"]);
  });

  it("finds an unnamed radio pair and labels it from the text before it", () => {
    const consent = fields.find((field) => field.options?.[0]?.startsWith("Yes - I consent"));
    expect(consent?.label).toContain("agree to text message updates");
    expect(consent?.options).toHaveLength(2);
  });

  it("ignores a lone button and keeps repeated groups separate", () => {
    expect(fields).toHaveLength(3);
    expect(fields.some((field) => field.options?.includes("Upload File"))).toBe(false);
  });
});

describe("matchOption", () => {
  const options = ["United States +1", "India +91", "I am not a protected veteran", "Yes", "No"];

  it("prefers exact, then prefix, then substring", () => {
    expect(BrowserParsing.matchOption(options, "yes")).toBe("Yes");
    expect(BrowserParsing.matchOption(options, "India")).toBe("India +91");
    expect(BrowserParsing.matchOption(options, "not a protected")).toBe("I am not a protected veteran");
  });

  it("only matches whole words, so India never picks Indianapolis", () => {
    expect(BrowserParsing.matchOption(["Indianapolis, IN, USA", "Indiana, USA"], "India")).toBeNull();
    expect(BrowserParsing.matchOption(["Indianapolis, IN, USA", "India"], "India")).toBe("India");
    expect(BrowserParsing.matchOption(["Mumbai, Maharashtra, India"], "India")).toBe("Mumbai, Maharashtra, India");
  });

  it("returns null when nothing fits", () => {
    expect(BrowserParsing.matchOption(options, "Maybe")).toBeNull();
  });
});

describe("Profile", () => {
  const resume = "# Deepanshu Mishra\n\nd4deepanshu723@gmail.com | linkedin.com/in/deepanshum | github.com/deepanshumishraa\n";

  it("seeds identity and links from the resume without guessing anything else", () => {
    const profile = Profile.seedFromResume(resume);
    expect(Profile.get(profile, "identity.firstName")).toBe("Deepanshu");
    expect(Profile.get(profile, "identity.lastName")).toBe("Mishra");
    expect(Profile.get(profile, "contact.email")).toBe("d4deepanshu723@gmail.com");
    expect(Profile.get(profile, "links.github")).toBe("https://github.com/deepanshumishraa");
    expect(Profile.get(profile, "contact.phone")).toBeNull();
  });

  it("round-trips through markdown and updates in place", () => {
    const profile = Profile.set(Profile.seedFromResume(resume), "visa.sponsorship.US", "yes", "user");
    const reparsed = Profile.parse(Profile.serialize(profile));
    expect(reparsed).toEqual(profile);
    const updated = Profile.set(reparsed, "visa.sponsorship.US", "no", "user");
    expect(updated.filter((fact) => fact.key === "visa.sponsorship.US")).toHaveLength(1);
    expect(Profile.get(updated, "visa.sponsorship.US")).toBe("no");
  });

  it("keeps values on one line", () => {
    expect(Profile.get(Profile.set([], "notes.a", "line one\nline two", "user"), "notes.a")).toBe("line one line two");
  });

  it("rejects malformed keys", () => {
    expect(Profile.isValidKey("visa.sponsorship.US")).toBe(true);
    expect(Profile.isValidKey("bad key")).toBe(false);
    expect(Profile.isValidKey("../x")).toBe(false);
  });
});

describe("extractCode", () => {
  it("finds a labelled code", () => {
    expect(GmailParsing.extractCode("Copy and paste this code into the application: Rxd1w0RE\nThanks")).toBe("Rxd1w0RE");
  });

  it("finds a code alone on a line", () => {
    expect(GmailParsing.extractCode("Hi,\n\nRxd1w0RE\n\nBye")).toBe("Rxd1w0RE");
  });

  it("ignores plain words that follow the word code", () => {
    expect(GmailParsing.extractCode("Our code editor is great")).toBeNull();
    expect(GmailParsing.extractCode("The code held. ALONGS newsletter")).toBeNull();
  });
});

describe("Writing.clean", () => {
  it("removes em and en dashes", () => {
    expect(Writing.clean("I built it — and shipped it")).toBe("I built it, and shipped it");
    expect(Writing.clean("2024–2025")).toBe("2024-2025");
    expect(Writing.hasDashes(Writing.clean("a — b – c"))).toBe(false);
  });
});

describe("Form.resolve", () => {
  const field = (id: number, label: string, kind: PlanField["kind"], options: string[] | null = null): PlanField => ({
    id, label, kind, options, required: true, value: "", ref: `e${id}`, ordinal: 0
  });
  const fields = [field(0, "First Name", "text"), field(1, "Sponsorship?", "select", ["Yes", "No"]), field(2, "Phone", "text"), field(3, "Why us?", "text")];
  const input = { fields, profile: [], job: { url: "https://x.test", title: "t", text: "" }, resume: "" };

  it("turns missing facts into deduplicated questions and keeps answers", () => {
    const plan = Form.resolve(input, [
      { id: 0, action: "answer", value: "Deepanshu", generated: false, question: null, profileKey: null },
      { id: 2, action: "ask", value: null, generated: null, question: "Phone number?", profileKey: "contact.phone" },
      { id: 3, action: "ask", value: null, generated: null, question: "Phone number again?", profileKey: "contact.phone" }
    ]);
    expect(plan.answers.map((answer) => answer.value)).toEqual(["Deepanshu"]);
    expect(plan.questions).toHaveLength(1);
    expect(plan.questions[0]).toMatchObject({ profileKey: "contact.phone" });
  });

  it("asks instead of filling when the chosen option does not exist", () => {
    const plan = Form.resolve(input, [{ id: 1, action: "answer", value: "Maybe", generated: false, question: null, profileKey: null }]);
    expect(plan.answers).toHaveLength(0);
    expect(plan.questions[0]?.options).toEqual(["Yes", "No"]);
  });

  it("strips dashes from generated text and skips undecided fields", () => {
    const plan = Form.resolve(input, [{ id: 3, action: "answer", value: "I like it — a lot", generated: true, question: null, profileKey: null }]);
    expect(plan.answers[0]).toMatchObject({ value: "I like it, a lot", generated: true });
    expect(plan.skipped.map((skipped) => skipped.label)).toEqual(["First Name", "Sponsorship?", "Phone"]);
  });
});

describe("resume html", () => {
  it("escapes markup and renders bullets and headings", () => {
    const html = ResumeParsing.toHtml("# Name <b>\n- did **a thing** & more");
    expect(html).toContain("<h1>Name &lt;b&gt;</h1>");
    expect(html).toContain("<li>did <b>a thing</b> &amp; more</li>");
  });
});
