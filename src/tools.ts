import { generateText, Output, tool } from "ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { listAllRepos, listFilesFromRepo } from "./octokit";
import { searchJobs } from "./jobs";
import { model } from "./model";
import { JobSchema } from "./schema";
import { YcCompanies } from "./yc-companies";

const DESCRIPTION_PREVIEW_CHARS = 400

const ProfileSchema = z.object({
  summary: z.string(),
  targetRole: z.string(),
  selectedRepositories: z.array(z.object({
    repository: z.string(),
    reason: z.string()
  })),
  skills: z.array(z.object({
    name: z.string(),
    evidence: z.string(),
    strength: z.enum(["strong", "working", "limited"])
  })),
  relevantExperience: z.array(z.string()),
  gaps: z.array(z.string()),
  resumeBullets: z.array(z.string())
});

const profilePrompt = (job: unknown, repositories: unknown, resume: string) => `
Build a truthful candidate profile for this job using the supplied resume and GitHub repository evidence.

Rules:
- Select only repositories relevant to the job.
- Treat code and README content as project evidence, not professional employment.
- Never claim a skill unless the repository evidence supports it.
- Mention missing requirements in gaps.
- Do not invent employers, dates, salary, production usage, or qualifications.
- Use the resume for verified professional experience and education.
- Use GitHub evidence for project and technical claims.
- Prefer resume experience over project-only evidence when describing employment.
- Return concise, specific content.

RESUME:
${resume}

JOB:
${JSON.stringify(job)}

GITHUB REPOSITORIES:
${JSON.stringify(repositories)}
`;

export const tools = {
  search_jobs: tool({
    description: "Find currently listed jobs matching roles, locations, and work mode",
    inputSchema: z.object({
      roles: z.array(z.string()).optional(),
      locations: z.array(z.string()).optional(),
      workMode: z.enum(["remote", "hybrid", "onsite"]).optional(),
      maxResults: z.number().int().optional().describe("Omit to get every match."),
      maxAgeDays: z.number().int().positive().optional().describe("Only jobs posted within this many days. Defaults to 30."),
      ycCompanyKeywords: z.array(z.string()).optional().describe(
        "Y Combinator company-domain keywords (e.g. 'developer tools', 'ai', 'fintech', 'infrastructure') matched against hiring YC companies' tags, industry, and one-liner. Up to 40 companies are read per search."
      ),
      ashbyBoards: z.array(z.string()).optional().describe(
        "Ashby job board slugs (the part after jobs.ashbyhq.com/, e.g. 'openai') for companies that fit the candidate. Slugs that do not exist are reported back as unreachable."
      )
    }),
    outputSchema: z.object({ jobs: z.array(JobSchema), unreachableAshbyBoards: z.array(z.string()) }),
    execute: async (query) => {
      const result = await searchJobs(query);
      // Results are uncapped, so shorten descriptions to keep the model's context manageable.
      return {
        ...result,
        jobs: result.jobs.map((job) => ({ ...job, description: job.description.slice(0, DESCRIPTION_PREVIEW_CHARS) }))
      };
    }
  }),

  find_yc_companies: tool({
    description: "Find Y Combinator companies from any or all batches (e.g. 'Winter 2024', 'Summer 2021'), optionally filtered by keywords and hiring status. Call with no batches to list every batch with its company count.",
    inputSchema: z.object({
      batches: z.array(z.string()).optional().describe("Batch names like 'Winter 2024'. Omit to search all batches."),
      keywords: z.array(z.string()).optional().describe("Matched against name, one-liner, industry, and tags."),
      hiringOnly: z.boolean().optional(),
      maxResults: z.number().int().optional().describe("Defaults to 100.")
    }),
    outputSchema: z.object({
      batches: z.array(z.object({ batch: z.string(), count: z.number() })).optional(),
      totalMatches: z.number().optional(),
      companies: z.array(z.object({
        name: z.string(),
        slug: z.string(),
        batch: z.string().nullable(),
        website: z.string(),
        oneLiner: z.string(),
        industry: z.string(),
        teamSize: z.number().nullable(),
        tags: z.array(z.string()),
        isHiring: z.boolean(),
        ycUrl: z.string()
      })).optional()
    }),
    execute: async ({ batches = [], keywords = [], hiringOnly, maxResults = 100 }) => {
      if (batches.length === 0 && keywords.length === 0 && !hiringOnly) {
        return { batches: await YcCompanies.batches() };
      }
      const terms = keywords.map((keyword) => keyword.toLowerCase());
      const matches = (await YcCompanies.inBatches(batches)).filter((company) => {
        const text = [company.name, company.oneLiner, company.industry, ...company.tags].join(" ").toLowerCase();
        return (!hiringOnly || company.isHiring) && (terms.length === 0 || terms.some((term) => text.includes(term)));
      });
      return { totalMatches: matches.length, companies: matches.slice(0, Math.max(1, maxResults)) };
    }
  }),

  get_yc_founders: tool({
    description: "Get founders (name, title, LinkedIn, X) and likely contact emails for YC companies by slug. Emails are either published on the company's site or unverified pattern guesses. Up to 10 slugs per call.",
    inputSchema: z.object({ slugs: z.array(z.string()).min(1).max(10) }),
    outputSchema: z.object({
      companies: z.array(z.discriminatedUnion("ok", [
        z.object({
          slug: z.string(),
          ok: z.literal(true),
          website: z.string(),
          linkedin: z.string().nullable(),
          twitter: z.string().nullable(),
          siteEmails: z.array(z.string()),
          founders: z.array(z.object({
            name: z.string(),
            title: z.string(),
            linkedin: z.string().nullable(),
            twitter: z.string().nullable(),
            publishedEmails: z.array(z.string()),
            emailGuesses: z.array(z.string())
          }))
        }),
        z.object({ slug: z.string(), ok: z.literal(false), error: z.string() })
      ]))
    }),
    execute: async ({ slugs }) => ({ companies: await Promise.all(slugs.map(YcCompanies.founders)) })
  }),

  list_github_repositories: tool({
    description: "List repositories belonging to the authenticated GitHub user",
    inputSchema: z.object({ scope: z.literal("all") }),
    outputSchema: z.object({ repositories: z.array(z.string()) }),
    execute: async () => {
      const repos = await listAllRepos();
      return { repositories: repos.map(({ owner, name }) => `${owner}/${name}`) };
    }
  }),

  get_github_repository_files: tool({
    description: "List relevant files in one authenticated GitHub repository by name",
    inputSchema: z.object({ repository: z.string() }),
    outputSchema: z.object({ repository: z.string(), files: z.array(z.string()) }),
    execute: async ({ repository }) => {
      const repos = await listAllRepos();
      const match = repos.find(
        ({ owner, name }) => name === repository || `${owner}/${name}` === repository
      );

      if (!match) {
        throw new Error(`Repository not found: ${repository}. Call list_github_repositories to see valid names.`);
      }

      const files = await listFilesFromRepo(match.owner, match.name);
      return { repository: `${match.owner}/${match.name}`, files };
    }
  }),

  build_job_profile: tool({
    description: "Build a truthful candidate profile for a job from selected GitHub repository evidence",
    inputSchema: z.object({
      job: z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        location: z.string(),
        compensation: z.number().nullable()
      }),
      repositories: z.array(z.object({
        repository: z.string(),
        files: z.array(z.string())
      }))
    }),
    outputSchema: ProfileSchema,
    execute: async ({ job, repositories }) => {
      const resume = await readFile("refs/resume.md", "utf8");
      const { output } = await generateText({
        model,
        prompt: profilePrompt(job, repositories, resume),
        output: Output.object({ schema: ProfileSchema })
      });
      return output;
    }
  })
};
