import { Octokit } from "octokit";

const GitHubClient = () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set. Add it to your environment and restart.");
  return new Octokit({ auth: token });
};

export const listAllRepos = async () => {
  const octokit = GitHubClient();

  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    visibility: "all",
    affiliation: "owner",
    sort: "updated",
    per_page: 100
  });

  return repos.map((repo) => ({
    owner: repo.owner.login,
    name: repo.name
  }));
};

export const listFilesFromRepo = async (owner: string, repo: string) => {
  const octokit = GitHubClient();

  const repository = await octokit.rest.repos.get({ owner, repo });

  if (repository.data.size === 0 || repository.data.default_branch.length === 0) {
    return [];
  }

  const ref = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${repository.data.default_branch}`
  });

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref.data.object.sha,
    recursive: "true"
  });

  if (tree.data.truncated) {
    throw new Error(`GitHub returned an incomplete file tree for ${owner}/${repo}. Try a smaller repository.`);
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
};
