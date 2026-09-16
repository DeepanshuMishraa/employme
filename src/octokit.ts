import { Config, Effect } from "effect";
import { Octokit } from "octokit";

export const listAllRepos = Effect.gen(function* () {
  const token = yield* Config.String("GITHUB_TOKEN");
  const octokit = new Octokit({ auth: token });

  const repos = yield* Effect.tryPromise({
    try: () =>
      octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        visibility: "all",
        affiliation: "owner,collaborator,organization_member",
        sort: "updated",
        per_page: 100
      }),
    catch: (cause) => new Error("Failed to list all repositories", { cause })
  });

  return repos.map((repo) => repo.name);
});
