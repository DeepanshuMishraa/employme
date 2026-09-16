import { Effect, Schema } from "effect";
import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import { listAllRepos, listFilesFromRepo } from "./octokit";

const UserGithubData = Tool.make("get_github_repository_data", {
  description: "List a user's repositories and relevant files",
  parameters: Schema.Struct({
    owner: Schema.String
  }),
  success: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      files: Schema.Array(Schema.String)
    })
  )
});

export const GithubTools = Toolkit.make(UserGithubData);

export const GithubToolLayer = GithubTools.toLayer({
  get_github_repository_data: ({ owner }) =>
    Effect.gen(function* () {
      const repos = yield* listAllRepos;

      return yield* Effect.forEach(repos, (repo) =>
        Effect.map(listFilesFromRepo(owner, repo), (files) => ({
          repo,
          files
        }))
      );
    }).pipe(
      Effect.mapError((cause) =>
        new AiError.UnknownError({
          description: cause instanceof Error ? cause.message : String(cause)
        })
      )
    )
});
