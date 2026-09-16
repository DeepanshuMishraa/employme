import { Config, Effect } from "effect";
import { Octokit } from "octokit";

export const GitHubClient = Effect.map(
  Config.String("GITHUB_TOKEN"),
  (token) => new Octokit({ auth: token })
);

export const listAllRepos = Effect.gen(function* () {
  const octokit = yield* GitHubClient;

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


export const listFilesFromRepo = (owner: string, repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* GitHubClient;

    const repository = yield* Effect.tryPromise({
      try: () => octokit.rest.repos.get({ owner, repo }),
      catch: (cause) => new Error("Failed to get repository", { cause })
    });

    const ref = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${repository.data.default_branch}`
        }),
      catch: (cause) => new Error("Failed to get repository branch", { cause })
    });

    const tree = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: ref.data.object.sha,
          recursive: "true"
        }),
      catch: (cause) => new Error("Failed to list repository files", { cause })
    });

    if (tree.data.truncated) {
      return yield* Effect.fail(
        new Error("GitHub returned an incomplete repository file tree")
      );
    }

    const ignoredPath = /(^|\/)(node_modules|dist|build|coverage|vendor|\.git)(\/|$)/i;
    const relevantFile = /(^|\/)(README\.md|package\.json|tsconfig\.json|Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/.*\.(ya?ml))$|\.(md|json|ya?ml|toml|lock|ts|tsx|js|jsx|py|go|rs|java|swift|kt|rb|php|cs|cpp|c|h|hpp|sql)$/i;

    return tree.data.tree
      .flatMap((entry) =>
        entry.type === "blob" && typeof entry.path === "string"
          ? [entry.path]
          : []
      )
      .filter((path) => !ignoredPath.test(path) && relevantFile.test(path));
  });
