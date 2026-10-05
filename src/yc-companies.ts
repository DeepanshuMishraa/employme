import { z } from "zod";

const YC_ORIGIN = "https://www.ycombinator.com";
const USER_AGENT = "Mozilla/5.0";
const SITE_TIMEOUT_MS = 4_000;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.|@2x|u00|domain\.com|email\.com/i;

export type YcCompany = {
  name: string;
  slug: string;
  batch: string | null;
  website: string;
  oneLiner: string;
  industry: string;
  teamSize: number | null;
  tags: string[];
  isHiring: boolean;
  ycUrl: string;
};

export type YcFounder = {
  name: string;
  title: string;
  linkedin: string | null;
  twitter: string | null;
  /** Addresses published on the company's own site that start with this founder's first name. */
  publishedEmails: string[];
  /** Pattern guesses (first@domain, first.last@domain, ...). Unverified. */
  emailGuesses: string[];
};

export type YcFounderProfile =
  | { slug: string; ok: true; website: string; linkedin: string | null; twitter: string | null; siteEmails: string[]; founders: YcFounder[] }
  | { slug: string; ok: false; error: string };

const algoliaOptsSchema = z.object({ app: z.string(), key: z.string() });

const hitSchema = z.object({
  name: z.string(),
  slug: z.string(),
  batch: z.string().nullish(),
  website: z.string().nullish(),
  one_liner: z.string().nullish(),
  subindustry: z.string().nullish(),
  team_size: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  isHiring: z.boolean().nullish()
});

const searchSchema = z.object({
  hits: z.array(hitSchema).default([]),
  nbPages: z.number().default(0),
  facets: z.object({ batch: z.record(z.string(), z.number()).optional() }).optional()
});

const founderPageSchema = z.object({
  props: z.object({
    company: z.object({
      website: z.string().nullish(),
      linkedin_url: z.string().nullish(),
      twitter_url: z.string().nullish(),
      founders: z.array(z.object({
        full_name: z.string().nullish(),
        title: z.string().nullish(),
        linkedin_url: z.string().nullish(),
        twitter_url: z.string().nullish()
      })).default([])
    })
  })
});

const SEASON_ORDER: Record<string, number> = { Winter: 1, Spring: 2, Summer: 3, Fall: 4 };

const batchOrder = (batch: string) => {
  const [season, year] = batch.split(" ");
  return Number(year) * 10 + (SEASON_ORDER[season ?? ""] ?? 0);
};

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const fetchText = async (url: string, timeoutMs = 8_000) => {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
};

let algoliaOpts: Promise<z.infer<typeof algoliaOptsSchema>> | null = null;

// YC's public company directory is backed by Algolia; its search-only key is embedded in the page.
const loadAlgoliaOpts = async () => {
  const html = await fetchText(`${YC_ORIGIN}/companies`);
  const match = html.match(/window\.AlgoliaOpts = \{"app":"(\w+)","key":"([^"]+)"/);
  if (!match) throw new Error("Could not read YC's company search credentials from ycombinator.com/companies; the page layout may have changed.");
  return algoliaOptsSchema.parse({ app: match[1], key: match[2] });
};

const algolia = async (params: Record<string, string | number>) => {
  algoliaOpts ??= loadAlgoliaOpts();
  const { app, key } = await algoliaOpts.catch((error) => {
    algoliaOpts = null;
    throw error;
  });
  const response = await fetch(`https://${app}-dsn.algolia.net/1/indexes/YCCompany_production/query`, {
    method: "POST",
    headers: { "X-Algolia-Application-Id": app, "X-Algolia-API-Key": key },
    body: JSON.stringify({ params: new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString() })
  });
  if (!response.ok) {
    algoliaOpts = null; // the key may have rotated; re-read it next time
    throw new Error(`YC company search failed with HTTP ${response.status}.`);
  }
  return searchSchema.parse(await response.json());
};

const toCompany = (hit: z.infer<typeof hitSchema>): YcCompany => ({
  name: hit.name,
  slug: hit.slug,
  batch: hit.batch ?? null,
  website: hit.website ?? "",
  oneLiner: hit.one_liner ?? "",
  industry: hit.subindustry ?? "",
  teamSize: hit.team_size ?? null,
  tags: hit.tags ?? [],
  isHiring: hit.isHiring ?? false,
  ycUrl: `${YC_ORIGIN}/companies/${hit.slug}`
});

const domainOf = (website: string) => {
  try {
    return new URL(website.includes("//") ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const nameParts = (fullName: string) =>
  fullName
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean);

const emailGuesses = (fullName: string, domain: string) => {
  const parts = nameParts(fullName);
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (!first || !domain) return [];
  return [
    `${first}@${domain}`,
    ...(last ? [`${first}.${last}@${domain}`, `${first[0]}${last}@${domain}`, `${first}${last}@${domain}`] : [])
  ];
};

const siteEmails = async (website: string, domain: string) => {
  const found = new Set<string>();
  const bodies = await Promise.allSettled(
    ["", "/contact"].map((path) => fetchText(website.replace(/\/$/, "") + path, SITE_TIMEOUT_MS))
  );
  for (const body of bodies) {
    if (body.status !== "fulfilled") continue;
    for (const raw of decodeURIComponentSafe(decodeEntities(body.value)).match(EMAIL_PATTERN) ?? []) {
      const email = raw.toLowerCase().replace(/^\.+|\.+$/g, "");
      const host = email.split("@")[1] ?? "";
      if (!JUNK_EMAIL.test(email) && (host === domain || host.endsWith(`.${domain}`))) found.add(email);
    }
  }
  return [...found].sort();
};

const decodeURIComponentSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const domainResolves = async (domain: string) => {
  try {
    await Bun.dns.lookup(domain);
    return true;
  } catch {
    return false;
  }
};

export const YcCompanies = {
  /** Every YC batch with its company count, newest first. */
  batches: async () => {
    const { facets } = await algolia({ hitsPerPage: 0, facets: JSON.stringify(["batch"]), maxValuesPerFacet: 1000 });
    return Object.entries(facets?.batch ?? {})
      .filter(([batch]) => batch !== "Unspecified")
      .sort(([a], [b]) => batchOrder(b) - batchOrder(a))
      .map(([batch, count]) => ({ batch, count }));
  },

  /** All companies in the given batches (every batch when none are given). */
  inBatches: async (batches: ReadonlyArray<string>) => {
    const targets = batches.length > 0 ? batches : (await YcCompanies.batches()).map(({ batch }) => batch);
    const perBatch = await Promise.all(targets.map(async (batch) => {
      const companies: YcCompany[] = [];
      for (let page = 0; ; page++) {
        const result = await algolia({
          hitsPerPage: 1000,
          page,
          facetFilters: JSON.stringify([[`batch:${batch}`]])
        });
        companies.push(...result.hits.map(toCompany));
        if (page + 1 >= result.nbPages) break;
      }
      return companies;
    }));
    return perBatch.flat();
  },

  /** Founders (names, titles, profiles, likely emails) for one company, read from its public YC page. */
  founders: async (slug: string): Promise<YcFounderProfile> => {
    if (!/^[a-z0-9-]{1,100}$/.test(slug)) {
      return { slug, ok: false, error: `"${slug}" is not a valid YC company slug (lowercase letters, digits, hyphens).` };
    }
    try {
      const html = await fetchText(`${YC_ORIGIN}/companies/${slug}`);
      const page = html.match(/data-page="([^"]*)"/)?.[1];
      if (!page) return { slug, ok: false, error: `No company data found on ${YC_ORIGIN}/companies/${slug}. The slug may be wrong.` };
      const { company } = founderPageSchema.parse(JSON.parse(decodeEntities(page))).props;
      const website = company.website ?? "";
      const domain = domainOf(website);
      const [emails, resolves] = domain
        ? await Promise.all([siteEmails(website, domain), domainResolves(domain)])
        : [[], false];
      return {
        slug,
        ok: true,
        website,
        linkedin: company.linkedin_url || null,
        twitter: company.twitter_url || null,
        siteEmails: emails,
        founders: company.founders.map((founder) => {
          const name = founder.full_name ?? "";
          const first = nameParts(name)[0] ?? "";
          return {
            name,
            title: founder.title ?? "",
            linkedin: founder.linkedin_url || null,
            twitter: founder.twitter_url || null,
            publishedEmails: emails.filter((email) => first !== "" && email.split("@")[0]?.startsWith(first)),
            emailGuesses: resolves ? emailGuesses(name, domain) : []
          };
        })
      };
    } catch (error) {
      return { slug, ok: false, error: `Could not read founders for ${slug}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
} as const;
