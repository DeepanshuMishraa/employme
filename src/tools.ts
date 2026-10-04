import { openai } from "@ai-sdk/openai";
import { generateText, Output, tool } from "ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { listAllRepos, listFilesFromRepo } from "./octokit";
import { searchJobs } from "./jobs";
import { JobSchema } from "./schema";

export const model = openai("gpt-6-luna");

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
      maxResults: z.number().int().optional()
    }),
    outputSchema: z.object({ jobs: z.array(JobSchema) }),
    execute: (query) => searchJobs(query)
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
