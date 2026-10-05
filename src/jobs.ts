import { z } from "zod";
import type { Job } from "./schema";
import { ycJobs } from "./yc";

export type JobQuery = {
  roles?: ReadonlyArray<string>;
  locations?: ReadonlyArray<string>;
  workMode?: "remote" | "hybrid" | "onsite";
  maxResults?: number;
  /** Drop jobs posted longer ago than this. Defaults to 30 days. */
  maxAgeDays?: number;
  ashbyBoards?: ReadonlyArray<string>;
  ycCompanyKeywords?: ReadonlyArray<string>;
};

const DEFAULT_MAX_AGE_DAYS = 30;

const stripHtml =(value: string) =>
  value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.json();
};

const arbeitnowSchema = z.object({
  data: z.array(z.object({
    slug: z.string(),
    company_name: z.string(),
    title: z.string(),
    description: z.string(),
    location: z.string(),
    remote: z.boolean(),
    tags: z.array(z.string()),
    created_at: z.number(),
    url: z.string()
  }))
});

const arbeitnow = async (): Promise<Job[]> => {
  const { data } = arbeitnowSchema.parse(await fetchJson("https://www.arbeitnow.com/api/job-board-api"));
  return data.map((job) => ({
    id: `arbeitnow:${job.slug}`,
    company: job.company_name,
    title: job.title,
    description: stripHtml(job.description),
    location: job.location || null,
    workMode: job.remote ? "remote" : "unknown",
    compensation: { min: null, max: null, currency: null },
    applyUrl: job.url,
    sourceUrl: "https://www.arbeitnow.com/",
    postedAt: new Date(job.created_at * 1000).toISOString(),
    fetchedAt: new Date().toISOString(),
    technologies: job.tags
  }));
};

const remoteOkSchema = z.array(z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  company: z.string().nullish(),
  position: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  date: z.string().nullish(),
  apply_url: z.string().nullish(),
  url: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish()
}));

const remoteOk = async (): Promise<Job[]> => {
  const jobs = remoteOkSchema.parse(await fetchJson("https://remoteok.com/api"));
  return jobs.flatMap((job) => {
    const applyUrl = job.apply_url ?? job.url;
    if (
      typeof job.company !== "string" ||
      typeof job.position !== "string" ||
      typeof job.description !== "string" ||
      typeof applyUrl !== "string" ||
      job.id == null ||
      job.id === "0"
    ) {
      return [];
    }

    return [{
      id: `remoteok:${job.id}`,
      company: job.company,
      title: job.position,
      description: stripHtml(job.description),
      location: job.location ?? null,
      workMode: "remote" as const,
      compensation: {
        min: job.salary_min ?? null,
        max: job.salary_max ?? null,
        currency: job.salary_min == null && job.salary_max == null ? null : "USD"
      },
      applyUrl,
      sourceUrl: "https://remoteok.com/",
      postedAt: job.date ?? null,
      fetchedAt: new Date().toISOString(),
      technologies: job.tags ?? []
    }];
  });
};

const jobicySchema = z.object({
  jobs: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    companyName: z.string(),
    jobTitle: z.string(),
    jobDescription: z.string(),
    jobGeo: z.string(),
    jobType: z.array(z.string()),
    jobTag: z.string().nullish(),
    pubDate: z.string(),
    url: z.string()
  }))
});

const jobicy = async (): Promise<Job[]> => {
  const { jobs } = jobicySchema.parse(await fetchJson("https://jobicy.com/api/v2/remote-jobs?count=100"));
  return jobs.map((job) => ({
    id: `jobicy:${job.id}`,
    company: job.companyName,
    title: job.jobTitle,
    description: stripHtml(job.jobDescription),
    location: job.jobGeo || null,
    workMode: "remote",
    compensation: { min: null, max: null, currency: null },
    applyUrl: job.url,
    sourceUrl: "https://jobicy.com/",
    postedAt: job.pubDate || null,
    fetchedAt: new Date().toISOString(),
    technologies: job.jobTag ? [job.jobTag, ...job.jobType] : job.jobType
  }));
};

const himalayasSchema = z.object({
  jobs: z.array(z.object({
    guid: z.string(),
    companyName: z.string(),
    title: z.string(),
    description: z.string(),
    minSalary: z.number().nullable(),
    maxSalary: z.number().nullable(),
    currency: z.string().nullable(),
    applicationLink: z.string(),
    pubDate: z.number(),
    categories: z.array(z.string())
  }))
});

const HIMALAYAS_PAGES = 5;

const himalayas = async (query: string): Promise<Job[]> => {
  const pages = await Promise.all(Array.from({ length: HIMALAYAS_PAGES }, (_, index) =>
    fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=${index + 1}`)
      .then((page) => himalayasSchema.parse(page).jobs)
      .catch(() => [])
  ));
  return pages.flat().map((job) => ({
    id: `himalayas:${job.guid}`,
    company: job.companyName,
    title: job.title,
    description: stripHtml(job.description),
    location: "Remote",
    workMode: "remote",
    compensation: { min: job.minSalary, max: job.maxSalary, currency: job.currency },
    applyUrl: job.applicationLink,
    sourceUrl: "https://himalayas.app/",
    postedAt: new Date(job.pubDate * 1000).toISOString(),
    fetchedAt: new Date().toISOString(),
    technologies: job.categories
  }));
};

const ashbySchema = z.object({
  jobs: z.array(z.object({
    id: z.string(),
    title: z.string(),
    department: z.string().nullish(),
    team: z.string().nullish(),
    location: z.string().nullish(),
    isListed: z.boolean(),
    isRemote: z.boolean().nullish(),
    workplaceType: z.string().nullish(),
    publishedAt: z.string().nullish(),
    jobUrl: z.string(),
    applyUrl: z.string(),
    descriptionPlain: z.string().nullish(),
    compensation: z.object({
      summaryComponents: z.array(z.object({
        compensationType: z.string(),
        interval: z.string(),
        currencyCode: z.string().nullish(),
        minValue: z.number().nullish(),
        maxValue: z.number().nullish()
      }))
    }).nullish()
  }))
});

const ashbyWorkMode = (workplaceType: string | null | undefined, isRemote: boolean | null | undefined): Job["workMode"] => {
  const type = workplaceType?.toLowerCase();
  if (type === "remote" || isRemote) return "remote";
  if (type === "hybrid") return "hybrid";
  if (type === "onsite") return "onsite";
  return "unknown";
};

const ashbyBoard = async (board: string): Promise<Job[]> => {
  const { jobs } = ashbySchema.parse(
    await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`)
  );
  return jobs.filter((job) => job.isListed).map((job) => {
    const salary = job.compensation?.summaryComponents.find(
      (component) => component.compensationType === "Salary" && component.interval === "1 YEAR"
    );
    return {
      id: `ashby:${board}:${job.id}`,
      company: board,
      title: job.title,
      description: job.descriptionPlain ?? "",
      location: job.location ?? null,
      workMode: ashbyWorkMode(job.workplaceType, job.isRemote),
      compensation: {
        min: salary?.minValue ?? null,
        max: salary?.maxValue ?? null,
        currency: salary?.currencyCode ?? null
      },
      applyUrl: job.applyUrl,
      sourceUrl: job.jobUrl,
      postedAt: job.publishedAt ?? null,
      fetchedAt: new Date().toISOString(),
      technologies: [job.department, job.team].filter((value): value is string => !!value)
    };
  });
};

// Ashby has no global search; the caller picks which company boards to query.
const ashby = async (boards: ReadonlyArray<string>) => {
  const settled = await Promise.allSettled(boards.map(ashbyBoard));
  return {
    jobs: settled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    unreachableBoards: boards.filter((_, index) => settled[index]?.status === "rejected")
  };
};

const failedSource = (source: Promise<Job[]>) => source.catch((): Job[] => []);

export const searchJobs = async (query: JobQuery) => {
  const roles = query.roles ?? [];
  const locations = (query.locations ?? [])
    .filter((location) => !["global", "worldwide", "anywhere"].includes(location.toLowerCase()));
  const keywords = roles.length > 0 ? roles.join(" ") : "software engineer typescript python go";

  const [arbeitnowJobs, remoteOkJobs, jobicyJobs, himalayasJobs, ycResult, ashbyResult] = await Promise.all([
    failedSource(arbeitnow()),
    failedSource(remoteOk()),
    failedSource(jobicy()),
    failedSource(himalayas(keywords)),
    failedSource(ycJobs(query.ycCompanyKeywords ?? [])),
    ashby(query.ashbyBoards ?? [])
  ]);
  const results = [arbeitnowJobs, remoteOkJobs, jobicyJobs, himalayasJobs, ycResult, ashbyResult.jobs];

  const roleTerms = roles.map((role) => role.toLowerCase());
  const locationTerms = locations.map((location) => location.toLowerCase());

  const cutoff = Date.now() - (query.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;
  const postedTime = (job: Job) => (job.postedAt ? Date.parse(job.postedAt) : Number.NaN);

  // Jobs with no usable posting date are dropped: their age can't be verified against the cutoff.
  const filtered = results.flat().filter((job) => {
    const text = `${job.title} ${job.description} ${job.technologies.join(" ")}`.toLowerCase();
    const roleMatches = roleTerms.length === 0 || roleTerms.some((term) => text.includes(term));
    const locationMatches = locationTerms.length === 0 || locationTerms.some((term) => (job.location ?? "").toLowerCase().includes(term));
    const modeMatches = query.workMode !== "remote" || job.workMode === "remote";
    return roleMatches && locationMatches && modeMatches && postedTime(job) >= cutoff;
  });

  const unique = [...new Map(filtered.map((job) => [job.applyUrl, job])).values()]
    .sort((a, b) => postedTime(b) - postedTime(a));
  return {
    jobs: query.maxResults === undefined ? unique : unique.slice(0, Math.max(1, query.maxResults)),
    unreachableAshbyBoards: ashbyResult.unreachableBoards
  };
};
