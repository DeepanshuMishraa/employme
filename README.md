# EmployMe

A personal job-search agent that connects your resume, GitHub projects, and live job listings.

It uses your GitHub repositories as evidence of what you have built, matches that evidence against open roles, and returns recommendations with the company, location, compensation when available, application link, strengths, and gaps.

The project currently runs as an iMessage service through Spectrum. It uses Effect for application flow and OpenAI for the agent and profile generation.

## Setup

Install dependencies:

```bash
bun install
```

Create a local `.env` file:

```env
OPENAI_API_KEY=your_openai_key
GITHUB_TOKEN=your_fine_grained_github_token
SPECTRUM_PROJECT_ID=your_spectrum_project_id
SPECTRUM_PROJECT_SECRET=your_spectrum_project_secret
```

Keep `.env` private. The GitHub token only needs read access to the repositories the agent should inspect.

Your resume belongs in:

```text
refs/resume.md
```

## Applying to jobs

The agent can fill application forms (Greenhouse and Ashby tested) and draft outreach emails. It never submits or sends without your approval in a later message.

1. Chrome for the browser layer, once: `./node_modules/.bin/agent-browser install`.
2. Facts it needs about you live in `refs/profile.md` (gitignored). It seeds name, email, and links from the resume, asks you once for anything else (visa, relocation, demographics), saves the answer, and never asks again. Edit the file to correct anything.
3. Optional Gmail, for reading emailed verification codes and creating or sending approved drafts. Create a Google Cloud OAuth client (Web application) with redirect `http://localhost:3000/oauth/google/callback`, enable the Gmail API, then add to `.env`:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# GOOGLE_REDIRECT_URI=...        defaults to the localhost callback above
# OAUTH_PORT=3000
# MAX_APPLICATIONS_PER_DAY=10
```

Ask the agent to connect Gmail and open the link it sends. The token is stored in `data/` (gitignored). While the app is in Google's Testing mode the token expires after about 7 days.

Local state (applications database, screenshots, Gmail token, generated resume PDF) lives in `data/`.

```bash
bun run check   # typecheck
bun run test    # unit tests
```

## Run

```bash
bun run src/index.ts
```

The current job search uses Arbeitnow's public job feed. Job listings without published compensation are returned without salary details.
