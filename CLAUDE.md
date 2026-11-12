# Rules for Claude in this repo

## About the project

- **Name:** christmas-beer
- **What it is:** a site for Jon and friends to rank Christmas beers during the yearly Christmas beer tasting.
- **Live:** https://christmas-beer.jonoba.no
- **Hosting:** Cloudflare Worker `christmas-beer` with custom domain `christmas-beer.jonoba.no`.
  Cloudflare Workers Builds deploys automatically on push to `main`.
  Other branches get a preview build.
- **Run locally:** `npm run dev`
- **Tests:** `npm test` (unit + API), `npm run test:e2e` (real Worker in `wrangler dev`),
  `npm run check` (types). CI runs all three.

The project is listed on jonoba.no/prosjekter through a card in the repo
`jongitoba/jonoba-nettside` (`src/content/projects/christmas-beer.md`). If the name,
description or URL changes here, tell Jon that the card there should be updated.
Do not change that repo from here.

## Stack

Chosen stack (the same as jonoba.no, plus D1):

- **Framework:** Astro with a static build, TypeScript in strict mode. Pages are plain
  Astro with small client scripts (`src/client/`), no UI framework.
- **Hosting:** Cloudflare Workers with static assets, configured in `wrangler.jsonc`.
- **Server logic:** one Worker (`worker/index.ts`), only for `/api/*` (`run_worker_first`).
  Static pages contain no data; everything is loaded from the API after login.
- **Storage:** Cloudflare D1 (binding `DB`), since the data is relational
  (tastings → participants → beers → ratings). The Worker creates its tables itself
  (`worker/db.ts`), so there is no migration step. Change the schema with care: use
  additive changes (`ALTER TABLE … ADD COLUMN`, `CREATE … IF NOT EXISTS`).
- **Auth:** a shared group code and a separate admin code, then you pick your name.
  `GROUP_CODE`, `ADMIN_CODE` and `SESSION_SECRET` are Cloudflare Secrets; there are no
  built-in fallback codes, and the API fails closed (500) if one is missing.
  Session is an HMAC-signed cookie (`worker/session.ts`).
- **Tests:** `node:test` for unit and API tests (`test/`, D1 is faked with `node:sqlite`),
  plus `scripts/test-e2e.mjs` against the real Worker.
- **Node:** `24`, pinned in `.node-version`.

Domain rules that the code depends on:

- Scores are 1–11 with up to 3 decimals, stored as integer thousandths.
- A beer's overall score is the average per criterion over everyone who scored it,
  then the mean of those criterion averages. Missing scores are left out.
- Criteria live in `src/lib/score.ts`. Each tasting stores its own copy, so editing the
  list only affects new years.
- Before the admin reveals a year, people only see their own scores. Revealed years
  are locked.

If the project needs something this stack handles poorly, suggest an alternative
and explain why before using it. Keep the suggestion short: what to use, why the
current stack falls short, and what it costs (money, complexity, a different deploy
setup). Wait for Jon's go-ahead before switching.

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
