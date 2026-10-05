import { z } from "zod";
import type { Job } from "./schema";

const YC_ORIGIN = "https://www.ycombinator.com";
const CONCURRENCY = 16;
const CACHE_TTL_MS = 30 * 60 * 1000;

const companySchema = z.array(z.object({
  name: z.string(),
  slug: z.string(),
  one_liner: z.string().nullish(),
  industry: z.string().nullish(),
  subindustry: z.string().nullish(),
  tags: z.array(z.string()),
  top_company: z.boolean(),
  batch: z.string().nullish()
}));

const postingSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  location: z.string().nullish(),
  type: z.string().nullish(),
  roleSpecificType: z.string().nullish(),
  prettyRole: z.string().nullish(),
  salaryRange: z.string().nullish(),
  minExperience: z.string().nullish(),
  visa: z.string().nullish(),
  skills: z.array(z.string()).nullish(),
  companyName: z.string(),
  companyUrl: z.string(),
  companyOneLiner: z.string().nullish(),
  createdAt: z.string().nullish()
});

const pageSchema = z.object({
  props: z.object({ jobPostings: z.array(postingSchema) })
});

type YcCompany = z.infer<typeof companySchema>[number];

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const fetchText = async (url: string) => {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
};

const cached = <T>(load: (key: string) => Promise<T>) => {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string) => {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = load(key);
    entries.set(key, { at: Date.now(), value });
    value.catch(() => entries.delete(key));
    return value;
  };
};

const hiringCompanies = cached(async () =>
  companySchema.parse(await (await fetch("https://yc-oss.github.io/api/companies/hiring.json")).json())
);

const companyPostings = cached(async (slug) => {
  const html = await fetchText(`${YC_ORIGIN}/companies/${slug}/jobs`);
  const page = html.match(/data-page="([^"]*)"/)?.[1];
  if (!page) throw new Error(`No job data found on YC jobs page for ${slug}`);
  return pageSchema.parse(JSON.parse(decodeEntities(page))).props.jobPostings;
});

const parseSalary = (range: string | null | undefined) => {
  const match = range?.match(/([\d.]+)\s*([KM]?)\s*-\s*\$?([\d.]+)\s*([KM]?)/i);
  const symbol = range?.match(/[$€£]/)?.[0];
  if (!match || !symbol) return { min: null, max: null, currency: null };
  const scale = (amount: string | undefined, unit: string | undefined) =>
    Number(amount) * (unit?.toUpperCase() === "K" ? 1_000 : unit?.toUpperCase() === "M" ? 1_000_000 : 1);
  return {
    min: scale(match[1], match[2]),
    max: scale(match[3], match[4] || match[2]),
    currency: { "$": "USD", "€": "EUR", "£": "GBP" }[symbol] ?? null
  };
};

const UNIT_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
  year: 31_557_600_000
} as const;

/** YC only shows relative ages ("about 2 months", "19 days"); convert to an approximate ISO date. */
const postedAtFromAge = (age: string | null | undefined) => {
  const match = age?.match(/(\d+|an?)\s+(minute|hour|day|week|month|year)s?/i);
  const unit = match?.[2]?.toLowerCase() as keyof typeof UNIT_MS | undefined;
  if (!match || !unit) return age?.toLowerCase().includes("less than") ? new Date().toISOString() : null;
  const count = /^an?$/i.test(match[1] ?? "") ? 1 : Number(match[1]);
  return new Date(Date.now() - count * UNIT_MS[unit]).toISOString();
};

const matchesKeywords =(company: YcCompany, keywords: ReadonlyArray<string>) => {
  const text = [company.one_liner, company.industry, company.subindustry, ...company.tags]
    .join(" ")
    .toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
};

const toJob = (posting: z.infer<typeof postingSchema>, company: YcCompany): Job => ({
  id: `yc:${posting.id}`,
  company: posting.companyName,
  title: posting.title,
  description: [
    posting.companyOneLiner,
    posting.type,
    posting.minExperience && `Experience: ${posting.minExperience}`,
    posting.visa && `Visa: ${posting.visa}`
  ].filter(Boolean).join(". "),
  location: posting.location ?? null,
  workMode: posting.location?.toLowerCase().includes("remote") ? "remote" : "unknown",
  compensation: parseSalary(posting.salaryRange),
  applyUrl: `${YC_ORIGIN}${posting.url}`,
  sourceUrl: `${YC_ORIGIN}${posting.companyUrl}`,
  postedAt: postedAtFromAge(posting.createdAt),
  fetchedAt: new Date().toISOString(),
  technologies: [
    ...[posting.prettyRole, posting.roleSpecificType].filter((value): value is string => !!value),
    ...(posting.skills ?? []),
    ...company.tags
  ]
});

const mapWithLimit = async <T, R>(items: ReadonlyArray<T>, limit: number, run: (item: T) => Promise<R>) => {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await run(item);
    }
  }));
  return results;
};

/**
 * YC has no public job search API. Take the companies YC lists as hiring, narrow them by
 * the company keywords (matched against tags, industry, and one-liner), then read each
 * matching company's public jobs page. Without keywords that is every hiring company,
 * which takes a while on a cold cache.
 */
export const ycJobs = async (companyKeywords: ReadonlyArray<string>): Promise<Job[]> => {
  const companies = await hiringCompanies("hiring");
  const selected = companies
    .filter((company) => companyKeywords.length === 0 || matchesKeywords(company, companyKeywords))
    .sort((a, b) => Number(b.top_company) - Number(a.top_company));

  const perCompany = await mapWithLimit(selected, CONCURRENCY, async (company) => {
    try {
      return (await companyPostings(company.slug)).map((posting) => toJob(posting, company));
    } catch {
      return [];
    }
  });
  return perCompany.flat();
};
