import { Effect, Schema } from "effect";

export const JobSchema = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  title: Schema.String,
  description: Schema.String,
  location: Schema.NullOr(Schema.String),
  workMode: Schema.Literals(["remote", "hybrid", "onsite", "unknown"]),
  compensation: Schema.Struct({
    min: Schema.NullOr(Schema.Number),
    max: Schema.NullOr(Schema.Number),
    currency: Schema.NullOr(Schema.String)
  }),
  applyUrl: Schema.String,
  sourceUrl: Schema.String,
  postedAt: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
  technologies: Schema.Array(Schema.String)
});

export type Job = typeof JobSchema.Type;

type JobQuery = {
  roles?: ReadonlyArray<string>;
  locations?: ReadonlyArray<string>;
  workMode?: "remote" | "hybrid" | "onsite";
  maxResults?: number;
};

const stripHtml = (value: string) =>
  value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const fetchJson = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    catch: (cause) => new Error(`Failed to fetch ${url}`, { cause })
  });

const arbeitnow = fetchJson("https://www.arbeitnow.com/api/job-board-api").pipe(
  Effect.flatMap((value) =>
    Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.Array(Schema.Struct({
          slug: Schema.String,
          company_name: Schema.String,
          title: Schema.String,
          description: Schema.String,
          location: Schema.String,
          remote: Schema.Boolean,
          tags: Schema.Array(Schema.String),
          created_at: Schema.Number,
          url: Schema.String
        }))
      })
    )(value)
  ),
  Effect.map(({ data }) => data.map((job) => ({
    id: `arbeitnow:${job.slug}`,
    company: job.company_name,
    title: job.title,
    description: stripHtml(job.description),
    location: job.location || null,
    workMode: job.remote ? "remote" as const : "unknown" as const,
    compensation: { min: null, max: null, currency: null },
    applyUrl: job.url,
    sourceUrl: "https://www.arbeitnow.com/",
    postedAt: new Date(job.created_at * 1000).toISOString(),
    fetchedAt: new Date().toISOString(),
    technologies: job.tags
  })))
);

const remoteOk = fetchJson("https://remoteok.com/api").pipe(
  Effect.flatMap((value) =>
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
        company: Schema.optional(Schema.NullOr(Schema.String)),
        position: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
        location: Schema.optional(Schema.NullOr(Schema.String)),
        tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        date: Schema.optional(Schema.NullOr(Schema.String)),
        apply_url: Schema.optional(Schema.NullOr(Schema.String)),
        url: Schema.optional(Schema.NullOr(Schema.String)),
        salary_min: Schema.optional(Schema.NullOr(Schema.Number)),
        salary_max: Schema.optional(Schema.NullOr(Schema.Number))
      }))
    )(value)
  ),
  Effect.map((jobs) => jobs.flatMap((job) => {
    const applyUrl = job.apply_url ?? job.url;
    if (
      typeof job.company !== "string" ||
      typeof job.position !== "string" ||
      typeof job.description !== "string" ||
      typeof applyUrl !== "string" ||
      job.id == null ||
      (typeof job.id === "string" && job.id === "0")
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
  }))
);

const jobicy = fetchJson("https://jobicy.com/api/v2/remote-jobs?count=100").pipe(
  Effect.flatMap((value) =>
    Schema.decodeUnknownEffect(
      Schema.Struct({
        jobs: Schema.Array(Schema.Struct({
          id: Schema.Union([Schema.String, Schema.Number]),
          companyName: Schema.String,
          jobTitle: Schema.String,
          jobDescription: Schema.String,
          jobGeo: Schema.String,
          jobType: Schema.Array(Schema.String),
          jobTag: Schema.optional(Schema.NullOr(Schema.String)),
          pubDate: Schema.String,
          url: Schema.String
        }))
      })
    )(value)
  ),
  Effect.map(({ jobs }) => jobs.map((job) => ({
    id: `jobicy:${job.id}`,
    company: job.companyName,
    title: job.jobTitle,
    description: stripHtml(job.jobDescription),
    location: job.jobGeo || null,
    workMode: "remote" as const,
    compensation: { min: null, max: null, currency: null },
    applyUrl: job.url,
    sourceUrl: "https://jobicy.com/",
    postedAt: job.pubDate || null,
    fetchedAt: new Date().toISOString(),
    technologies: job.jobTag ? [job.jobTag, ...job.jobType] : job.jobType
  })))
);

const himalayas = (query: string) =>
  fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=1`).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          jobs: Schema.Array(Schema.Struct({
            guid: Schema.String,
            companyName: Schema.String,
            title: Schema.String,
            description: Schema.String,
            minSalary: Schema.NullOr(Schema.Number),
            maxSalary: Schema.NullOr(Schema.Number),
            currency: Schema.NullOr(Schema.String),
            applicationLink: Schema.String,
            pubDate: Schema.Number,
            categories: Schema.Array(Schema.String)
          }))
        })
      )(value)
    ),
    Effect.map(({ jobs }) => jobs.map((job) => ({
      id: `himalayas:${job.guid}`,
      company: job.companyName,
      title: job.title,
      description: stripHtml(job.description),
      location: "Remote",
      workMode: "remote" as const,
      compensation: { min: job.minSalary, max: job.maxSalary, currency: job.currency },
      applyUrl: job.applicationLink,
      sourceUrl: "https://himalayas.app/",
      postedAt: new Date(job.pubDate).toISOString(),
      fetchedAt: new Date().toISOString(),
      technologies: job.categories
    })))
  );

const failedSource = <A>(source: Effect.Effect<ReadonlyArray<A>, unknown>) =>
  source.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<A>>([])));

export const searchJobs = (query: JobQuery) => {
  const roles = query.roles ?? [];
  const locations = (query.locations ?? [])
    .filter((location) => !["global", "worldwide", "anywhere"].includes(location.toLowerCase()));
  const keywords = roles.length > 0 ? roles.join(" ") : "software engineer typescript python go";

  return Effect.gen(function* () {
    const results = yield* Effect.all({
      arbeitnow: failedSource(arbeitnow),
      remoteOk: failedSource(remoteOk),
      jobicy: failedSource(jobicy),
      himalayas: failedSource(himalayas(keywords))
    }, { concurrency: "unbounded" });

    const roleTerms = roles.map((role) => role.toLowerCase());
    const locationTerms = locations.map((location) => location.toLowerCase());
    const jobs = Object.values(results).flat();

    const filtered = jobs.filter((job) => {
      const text = `${job.title} ${job.description} ${job.technologies.join(" ")}`.toLowerCase();
      const roleMatches = roleTerms.length === 0 || roleTerms.some((term) => text.includes(term));
      const locationMatches = locationTerms.length === 0 || locationTerms.some((term) => (job.location ?? "").toLowerCase().includes(term));
      const modeMatches = query.workMode !== "remote" || job.workMode === "remote";
      return roleMatches && locationMatches && modeMatches;
    });

    const unique = new Map(filtered.map((job) => [job.applyUrl, job]));
    return { jobs: [...unique.values()].slice(0, Math.max(1, Math.min(query.maxResults ?? 20, 50))) };
  });
};
