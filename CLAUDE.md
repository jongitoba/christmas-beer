# Rules for Claude in this repo

## About the project

- **Name:** christmas-beer
- **What it is:** a site for Jon and friends to rank Christmas beers during the yearly Christmas beer tasting.
- **Live:** https://christmas-beer.jonoba.no
- **Hosting:** Cloudflare Worker `christmas-beer` with custom domain `christmas-beer.jonoba.no`.
  Cloudflare Workers Builds deploys automatically on push to `main`.
  Other branches get a preview build.
- **Run locally:** `npm run dev`
- **Tests:** `npm test`

The project is listed on jonoba.no/prosjekter through a card in the repo
`jongitoba/jonoba-nettside` (`src/content/prosjekter/christmas-beer.md`). If the name,
description or URL changes here, tell Jon that the card there should be updated.
Do not change that repo from here.

## Stack

Start with the same stack as jonoba.no, so all projects work the same way:

- **Framework:** Astro with a static build, TypeScript in strict mode
- **Hosting:** Cloudflare Workers with static assets, configured in `wrangler.jsonc`
- **Server logic:** one Worker (`worker/index.ts`), only for the routes that need it
  (`run_worker_first`). Everything else is served statically.
- **Storage:** Cloudflare KV. Use D1 instead if the data is relational.
- **Tests:** `node:test` for unit tests. Add an e2e script if there is auth or
  private data.
- **Node:** version pinned in `.node-version` (jonoba.no uses `24`). Use the same as
  jonoba.no unless there is a reason not to.

If the project needs something this stack handles poorly, suggest an alternative
and explain why before using it. Examples:
- Heavy client-side interactivity → React or Svelte islands inside Astro, or Vite + React.
- A full-stack app → Next.js on Workers via OpenNext.
- Python, long-running jobs or Docker → a host outside Cloudflare.

Keep the suggestion short: what to use, why the default falls short, and what it
costs (money, complexity, a different deploy setup). Wait for Jon's go-ahead before
switching. Once a stack is chosen, record it here, replacing this section's defaults.

## Language

- **Website content is Norwegian:** everything a visitor sees, such as page text,
  titles, meta descriptions, alt text, URL paths and error messages shown on the page.
- **Everything else is English:** code, identifiers, code comments, commit messages,
  branch names, PR titles and descriptions, CLAUDE.md, README and other developer
  docs, and all conversation with Jon.

## Branches

- All work happens on a separate branch. Never commit directly to `main`.
- Name it `claude/` followed by 1–3 keywords describing the content, joined by hyphens,
  e.g. `claude/login-page` or `claude/fix-csv-export`.
- Branch off an up-to-date `main`: `git fetch origin && git switch -c claude/<keywords> origin/main`.
- A new task means a new branch. Never build on a branch that has already been merged.
- Once merged, delete the branch both on GitHub and locally.

## Pull requests and merging

GitHub does not enforce these rules (a private repo without GitHub Pro), so they
have to be followed manually.

1. Push the branch and open a PR against `main`.
2. Run `gh pr checks <nr>` and confirm that every expected check is registered:
   - `Workers Builds: christmas-beer` (Cloudflare)
   - `test` (GitHub Actions), once CI is set up in `.github/workflows/ci.yml`

   Right after a push a check can be missing, and then `--watch` only waits for
   the others. If a check never shows up, tell Jon. Do not treat it as passed.
3. `gh pr checks <nr> --watch --fail-fast`. Wait until all checks pass.
4. If a check fails, do not merge. Report the failure and fix it first.
5. When everything is green, tell Jon and **wait for approval**. Never merge unless
   Jon has approved this specific PR. Approval of one PR does not carry over to the next.
6. After approval: `gh pr merge <nr> --merge --delete-branch`.

## Secrets and config

- No secrets in the repo: not in code, `wrangler.jsonc` or commits. Local values
  go in `.dev.vars`, which must be listed in `.gitignore`.
- Add secrets in Cloudflare as type **Secret** (in the dashboard or with
  `npx wrangler secret put <NAME>`), never as Text/Variable. Plain variables are
  overwritten on every deploy.
- If Cloudflare suggests "updating your Wrangler configuration" with `vars` that
  contain secrets, do not paste them in. Convert the variables to Secrets instead.

## Constraints

- Everything stays within Cloudflare's free tiers (Workers 100k requests/day, KV,
  D1). Tell Jon before suggesting anything that costs money.
- Do not change DNS, domains or Cloudflare settings without asking first.
