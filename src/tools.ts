import { Effect, Schema } from "effect";
import { AiError, Tool, Toolkit } from "effect/unstable/ai";
import { listAllRepos, listFilesFromRepo } from "./octokit";

const UserGithubData = Tool.make("get_github_repository_data", {
  description: "List the authenticated GitHub user's repositories and relevant files",
  parameters: Schema.Struct({
    scope: Schema.Literal("all")
  }),
  success: Schema.Struct({
    repositories: Schema.Array(
      Schema.Struct({
        repo: Schema.String,
        files: Schema.Array(Schema.String)
      })
    )
  })
});

export const GithubTools = Toolkit.make(UserGithubData);

export const GithubToolLayer = GithubTools.toLayer({
  get_github_repository_data: () =>
    Effect.gen(function* () {
      const repos = yield* listAllRepos;

      const repositories = yield* Effect.forEach(repos, ({ owner, name }) =>
        Effect.map(listFilesFromRepo(owner, name), (files) => ({
          repo: `${owner}/${name}`,
          files
        }))
      );

      return { repositories };
    }).pipe(
      Effect.mapError((cause) =>
        new AiError.UnknownError({
          description: cause instanceof Error ? cause.message : String(cause)
        })
      )
    )
});
