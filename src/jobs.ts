import { z } from "zod";
import type { Job } from "./schema";

export type JobQuery = {
  roles?: ReadonlyArray<string>;
  locations?: ReadonlyArray<string>;
  workMode?: "remote" | "hybrid" | "onsite";
  maxResults?: number;
};

const stripHtml = (value: string) =>
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

const himalayas = async (query: string): Promise<Job[]> => {
  const { jobs } = himalayasSchema.parse(
    await fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=1`)
  );
  return jobs.map((job) => ({
    id: `himalayas:${job.guid}`,
    company: job.companyName,
    title: job.title,
    description: stripHtml(job.description),
    location: "Remote",
    workMode: "remote",
    compensation: { min: job.minSalary, max: job.maxSalary, currency: job.currency },
    applyUrl: job.applicationLink,
    sourceUrl: "https://himalayas.app/",
    postedAt: new Date(job.pubDate).toISOString(),
    fetchedAt: new Date().toISOString(),
    technologies: job.categories
  }));
};

// A failing source must not sink the whole search.
const failedSource = (source: Promise<Job[]>) => source.catch((): Job[] => []);

export const searchJobs = async (query: JobQuery) => {
  const roles = query.roles ?? [];
  const locations = (query.locations ?? [])
    .filter((location) => !["global", "worldwide", "anywhere"].includes(location.toLowerCase()));
  const keywords = roles.length > 0 ? roles.join(" ") : "software engineer typescript python go";

  const results = await Promise.all([
    failedSource(arbeitnow()),
    failedSource(remoteOk()),
    failedSource(jobicy()),
    failedSource(himalayas(keywords))
  ]);

  const roleTerms = roles.map((role) => role.toLowerCase());
  const locationTerms = locations.map((location) => location.toLowerCase());

  const filtered = results.flat().filter((job) => {
    const text = `${job.title} ${job.description} ${job.technologies.join(" ")}`.toLowerCase();
    const roleMatches = roleTerms.length === 0 || roleTerms.some((term) => text.includes(term));
    const locationMatches = locationTerms.length === 0 || locationTerms.some((term) => (job.location ?? "").toLowerCase().includes(term));
    const modeMatches = query.workMode !== "remote" || job.workMode === "remote";
    return roleMatches && locationMatches && modeMatches;
  });

  const unique = new Map(filtered.map((job) => [job.applyUrl, job]));
  return { jobs: [...unique.values()].slice(0, Math.max(1, Math.min(query.maxResults ?? 20, 50))) };
};
