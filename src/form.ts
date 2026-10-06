import { generateText, Output } from "ai";
import { z } from "zod";
import { BrowserParsing, type Field } from "./browser";
import { model } from "./model";
import type { Profile } from "./profile";
import { Writing } from "./writing";

/** Dropdowns longer than this (country lists) are matched by fuzzy lookup instead of listed to the model. */
const MAX_LISTED_OPTIONS = 40;

export type PlanField = Field & { id: number };

export type Question = {
  profileKey: string;
  question: string;
  options: string[] | null;
};

export type Answer = { field: Field; value: string; generated: boolean };

export type Plan = {
  answers: Answer[];
  questions: Question[];
  skipped: Field[];
};

export type PlanInput = {
  fields: PlanField[];
  profile: Profile;
  job: { url: string; title: string; text: string };
  resume: string;
};

const DecisionSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.number().int(),
      action: z.enum(["answer", "ask", "skip"]),
      value: z.string().nullable().describe("The text to enter or the option to choose. Required for answer."),
      generated: z.boolean().nullable().describe("True when you wrote the value yourself instead of copying a profile fact."),
      question: z.string().nullable().describe("Plain question for the user. Required for ask."),
      profileKey: z.string().nullable().describe("Dotted key to save the user's reply under. Required for ask.")
    })
  )
});

const factsBlock = (profile: Profile) =>
  profile.length === 0 ? "(empty)" : profile.map((fact) => `${fact.key} = ${fact.value}`).join("\n");

const fieldsBlock = (fields: PlanField[]) =>
  fields
    .map((field) => {
      const options = field.options ? ` options=${JSON.stringify(field.options)}` : field.kind === "select" ? " options=(long list, name the value you want)" : "";
      return `[${field.id}] ${field.kind}${field.required ? " required" : ""} label=${JSON.stringify(field.label)} current=${JSON.stringify(field.value)}${options}`;
    })
    .join("\n");

const prompt = ({ fields, profile, job, resume }: PlanInput) => `
You fill in a job application form for the candidate. Decide an action for every field.

Actions:
- answer: enter value. For dropdowns and choice fields (radio groups, Yes/No buttons), value must be one of the listed options, copied exactly. For long lists, give the plain value (for example "India").
- ask: the answer is a personal, legal, or factual matter that the profile does not contain. Write one plain question and a profileKey.
- skip: optional field with nothing useful to add, or a field already holding the right value.

Facts and legal matters (identity, contact, links, location, visa and work authorization, relocation, availability, demographics, veteran or disability status, criminal history, agreements, consent boxes, salary):
- Answer only from the profile facts below. Never guess, never infer from the resume, never pick a convenient option.
- If a fact is missing, ask. Use keys like contact.phone, visa.sponsorship.<job country code>, relocation.open, demographics.gender, agreement.arbitration.<company>.
- Location fields (current location, city, where you are based) need a city, not just a country. Use contact.location. If the profile only has a country, ask for the city instead of answering with the country.
- Visa sponsorship depends on the country of the job. Use the job's country in the key.
- Agreements and arbitration terms are per employer, so key them to the company. Ask even if another employer was agreed to before.
- Acknowledgements are not personal facts. A dropdown whose only purpose is to confirm that the candidate read or understood a policy or guideline (for example "I will read the agreement below", or "confirm you understand our AI guidelines by selecting Yes") gets the affirmative option. Actually agreeing to legal terms (for example "I agree to the Agreement to Arbitrate") still follows the agreement rule above.
- If the profile value is "decline" for a demographic question, choose the option meaning prefer not to answer.
- Optional demographic fields with no profile fact: ask once.

Open questions (why this company, projects, extra information):
- Write them yourself with generated=true. Use only things in the resume. Do not invent employers, dates, numbers, or skills.
- Sound like a person: first person, specific, 2 to 4 sentences, no buzzwords, no em dashes or en dashes.
- Leave optional open questions blank unless the answer clearly helps.

Soft preferences (start date, deadlines): use a short honest answer if the profile has one, otherwise skip when optional and ask when required.

PROFILE FACTS:
${factsBlock(profile)}

JOB:
${job.title}
${job.url}
${job.text}

RESUME:
${resume}

FIELDS:
${fieldsBlock(fields)}
`;

const resolve = (input: PlanInput, decisions: z.infer<typeof DecisionSchema>["decisions"]): Plan => {
  const byId = new Map(input.fields.map((field) => [field.id, field]));
  const plan: Plan = { answers: [], questions: [], skipped: [] };
  const asked = new Set<string>();
  const ask = (question: Question) => {
    if (asked.has(question.profileKey)) return;
    asked.add(question.profileKey);
    plan.questions.push(question);
  };

  for (const decision of decisions) {
    const field = byId.get(decision.id);
    if (!field) continue;
    if (decision.action === "skip") {
      plan.skipped.push(field);
    } else if (decision.action === "ask") {
      if (decision.question && decision.profileKey) {
        ask({ profileKey: decision.profileKey, question: decision.question, options: field.options });
      } else {
        plan.skipped.push(field);
      }
    } else if (decision.value) {
      const value = Writing.clean(decision.value);
      const unmatched = field.options && !BrowserParsing.matchOption(field.options, value);
      if (unmatched) {
        ask({ profileKey: `answer.${BrowserParsing.normalize(field.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`, question: field.label, options: field.options });
      } else {
        plan.answers.push({ field, value, generated: decision.generated ?? false });
      }
    } else {
      plan.skipped.push(field);
    }
  }

  const decided = new Set(decisions.map((decision) => decision.id));
  for (const field of input.fields) {
    if (!decided.has(field.id)) plan.skipped.push(field);
  }
  return plan;
};

export const Form = {
  MAX_LISTED_OPTIONS,
  resolve,
  plan: async (input: PlanInput): Promise<Plan> => {
    const { output } = await generateText({
      model,
      prompt: prompt(input),
      output: Output.object({ schema: DecisionSchema })
    });
    return resolve(input, output.decisions);
  }
} as const;
