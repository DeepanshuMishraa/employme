import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PROFILE_PATH = "refs/profile.md";
const RESUME_PATH = "refs/resume.md";
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const FACT_LINE = /^- ([A-Za-z0-9_.-]+): (.*?)(?: <!-- (user|resume|inferred) (\d{4}-\d{2}-\d{2}) -->)?$/;

export type FactSource = "user" | "resume" | "inferred";

export type Fact = { key: string; value: string; source: FactSource; date: string };

/**
 * Everything the agent knows about the user, one fact per line in refs/profile.md.
 * Keys are dotted, e.g. `contact.phone` or `visa.sponsorship.US`. Facts that depend on the
 * job's country or employer carry that in the key so they are asked again only when it changes.
 */
export type Profile = readonly Fact[];

const isSource = (value: string | undefined): value is FactSource =>
  value === "user" || value === "resume" || value === "inferred";

const today = () => new Date().toISOString().slice(0, 10);

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

const parse = (markdown: string): Profile =>
  markdown.split("\n").flatMap((line) => {
    const match = FACT_LINE.exec(line.trim());
    const [, key, value, source, date] = match ?? [];
    if (!key || value === undefined) return [];
    return [{ key, value, source: isSource(source) ? source : "user", date: date ?? today() }];
  });

const serialize = (profile: Profile) => {
  const groups = new Map<string, Fact[]>();
  for (const fact of profile) {
    const group = fact.key.split(".")[0] ?? fact.key;
    groups.set(group, [...(groups.get(group) ?? []), fact]);
  }
  const sections = [...groups].map(
    ([group, facts]) =>
      `## ${group}\n${facts.map((fact) => `- ${fact.key}: ${fact.value} <!-- ${fact.source} ${fact.date} -->`).join("\n")}`
  );
  return `# Profile\n\nMaintained by the agent. Edit any line to correct it.\n\n${sections.join("\n\n")}\n`;
};

const get = (profile: Profile, key: string) => profile.find((fact) => fact.key === key)?.value ?? null;

const set = (profile: Profile, key: string, value: string, source: FactSource): Profile => {
  const next: Fact = { key, value: singleLine(value), source, date: today() };
  return profile.some((fact) => fact.key === key)
    ? profile.map((fact) => (fact.key === key ? next : fact))
    : [...profile, next];
};

/** Name, email and links are read straight from the resume; nothing is guessed. */
const seedFromResume = (resume: string): Profile => {
  const name = /^#\s+(.+)$/m.exec(resume)?.[1]?.trim();
  const [lastName, ...rest] = name ? name.split(/\s+/).reverse() : [];
  const firstName = rest.reverse().join(" ");
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(resume)?.[0];
  const linkedin = /linkedin\.com\/in\/[\w-]+/i.exec(resume)?.[0];
  const github = /github\.com\/[\w-]+/i.exec(resume)?.[0];
  const entries: [string, string | undefined][] = [
    ["identity.firstName", firstName || undefined],
    ["identity.lastName", lastName],
    ["contact.email", email],
    ["links.linkedin", linkedin && `https://${linkedin}`],
    ["links.github", github && `https://${github}`]
  ];
  return entries.flatMap(([key, value]) => (value ? [{ key, value, source: "resume" as const, date: today() }] : []));
};

const save = async (profile: Profile) => {
  await mkdir(dirname(PROFILE_PATH), { recursive: true });
  await writeFile(PROFILE_PATH, serialize(profile), "utf8");
};

const load = async (): Promise<Profile> => {
  try {
    return parse(await readFile(PROFILE_PATH, "utf8"));
  } catch {
    const seeded = seedFromResume(await readFile(RESUME_PATH, "utf8"));
    await save(seeded);
    return seeded;
  }
};

export const Profile = {
  isValidKey: (key: string) => KEY_PATTERN.test(key),
  parse,
  serialize,
  get,
  set,
  seedFromResume,
  load,
  save
} as const;
