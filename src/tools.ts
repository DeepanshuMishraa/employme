import { Effect, Schema } from "effect";
import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import { listAllRepos, listFilesFromRepo } from "./octokit";

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

const toAiError = (cause: unknown) =>
  new AiError.UnknownError({
    description: cause instanceof Error ? cause.message : String(cause)
  });

export const GithubTools = Toolkit.make(ListGithubRepos, GetGithubRepoFiles);

export const GithubToolLayer = GithubTools.toLayer({
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
    }).pipe(Effect.mapError(toAiError))
});
