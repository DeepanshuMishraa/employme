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

## Run

```bash
bun run src/index.ts
```

The current job search uses Arbeitnow's public job feed. Job listings without published compensation are returned without salary details.
