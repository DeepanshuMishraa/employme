import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { readFile } from "node:fs/promises";
import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { AiError, Chat, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { listAllRepos, listFilesFromRepo } from "./octokit";
import { JobSchema, searchJobs } from "./jobs";

export const OpenAI = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer));

export const model = OpenAiLanguageModel.model("gpt-5.6-luna");

const SearchJobs = Tool.make("search_jobs", {
  description: "Find currently listed jobs matching roles, locations, and work mode",
  parameters: Schema.Struct({
    roles: Schema.optional(Schema.Array(Schema.String)),
    locations: Schema.optional(Schema.Array(Schema.String)),
    workMode: Schema.optional(Schema.Literals(["remote", "hybrid", "onsite"])),
    maxResults: Schema.optional(Schema.Int)
  }),
  success: Schema.Struct({
    jobs: Schema.Array(JobSchema)
  })
});

const ListGithubRepos = Tool.make("list_github_repositories", {
  description: "List repositories belonging to the authenticated GitHub user",
  parameters: Schema.Struct({
    scope: Schema.Literal("all")
  }),
  success: Schema.Struct({
    repositories: Schema.Array(Schema.String)
  })
});

const GetGithubRepoFiles = Tool.make("get_github_repository_files", {
  description: "List relevant files in one authenticated GitHub repository by name",
  parameters: Schema.Struct({
    repository: Schema.String
  }),
  success: Schema.Struct({
    repository: Schema.String,
    files: Schema.Array(Schema.String)
  })
});

const BuildJobProfile = Tool.make("build_job_profile", {
  description: "Build a truthful candidate profile for a job from selected GitHub repository evidence",
  parameters: Schema.Struct({
    job: Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.String,
      location: Schema.String,
      compensation: Schema.NullOr(Schema.Number)
    }),
    repositories: Schema.Array(
      Schema.Struct({
        repository: Schema.String,
        files: Schema.Array(Schema.String)
      })
    )
  }),
  success: Schema.Struct({
    summary: Schema.String,
    targetRole: Schema.String,
    selectedRepositories: Schema.Array(
      Schema.Struct({
        repository: Schema.String,
        reason: Schema.String
      })
    ),
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        evidence: Schema.String,
        strength: Schema.Literals(["strong", "working", "limited"])
      })
    ),
    relevantExperience: Schema.Array(Schema.String),
    gaps: Schema.Array(Schema.String),
    resumeBullets: Schema.Array(Schema.String)
  })
});

const toAiError = (cause: unknown) =>
  new AiError.UnknownError({
    description: cause instanceof Error ? cause.message : String(cause)
  });

const LocalFileSystem = FileSystem.makeNoop({
  readFileString: (path) => Effect.promise(() => readFile(path, "utf8"))
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

export const GithubTools = Toolkit.make(
  SearchJobs,
  ListGithubRepos,
  GetGithubRepoFiles,
  BuildJobProfile
);

export const GithubToolLayer = GithubTools.toLayer({
  search_jobs: (query) => searchJobs(query).pipe(Effect.mapError(toAiError)),

  list_github_repositories: () =>
    Effect.gen(function* () {
      const repos = yield* listAllRepos;

      return {
        repositories: repos.map(({ owner, name }) => `${owner}/${name}`)
      };
    }).pipe(Effect.mapError(toAiError)),

  get_github_repository_files: ({ repository }) =>
    Effect.gen(function* () {
      const repos = yield* listAllRepos;
      const match = repos.find(
        ({ owner, name }) =>
          name === repository || `${owner}/${name}` === repository
      );

      if (!match) {
        return yield* Effect.fail(
          new Error(`Repository not found: ${repository}`)
        );
      }

      const files = yield* listFilesFromRepo(match.owner, match.name);

      return {
        repository: `${match.owner}/${match.name}`,
        files
      };
    }).pipe(Effect.mapError(toAiError)),

  build_job_profile: ({ job, repositories }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const resume = yield* fileSystem.readFileString("refs/resume.md");

      const chat = yield* Chat.empty;
      const response = yield* chat.generateObject({
        prompt: profilePrompt(job, repositories, resume),
        schema: BuildJobProfile.successSchema
      });

      return response.value;
    }).pipe(
      Effect.provide(model),
      Effect.provide(OpenAI),
      Effect.provideService(FileSystem.FileSystem, LocalFileSystem),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(toAiError)
    )
});
