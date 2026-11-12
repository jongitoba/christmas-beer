# christmas-beer

A site for ranking Christmas beers at the yearly tasting: https://christmas-beer.jonoba.no

Everyone brings their own beer, adds it to the site, and scores every beer from 1 to 11
(up to 3 decimals) on Utseende, Lyd, Rase, Fylde, Smak and Wok. A beer's overall score is
the mean of its per-criterion averages. Scores stay hidden until the admin reveals them.

## Development

```sh
npm install
npm run dev          # http://localhost:4321 – Astro + Worker with a local D1 database
npm test             # unit and API tests
npm run test:e2e     # builds and tests the real Worker in wrangler dev
npm run check        # type-check pages and Worker
```

`npm run dev` creates `.dev.vars` from `.dev.vars.example` the first time. Log in locally
with `jul` (member) or `nisse` (admin), the local-only codes from `.dev.vars`.

It hot reloads: edits to pages, client scripts and CSS show up in the open browser tab
right away, and edits to `worker/` or `src/lib/` rebuild the Worker so the next API call
uses the new code. No restart needed. The local database lives in `.wrangler/` and
survives restarts; delete that folder to start fresh.

## How it works

- `src/pages/` – static Astro pages in Norwegian: `/` (code and name), `/smaking/`,
  `/resultater/`, `/admin/`. They fetch everything from the API in the browser.
- `worker/index.ts` – the API under `/api/*`, the only thing the Worker handles.
- `worker/db.ts` – D1 schema (created automatically) and queries.
- `worker/session.ts` – signed session cookie.
- `src/lib/score.ts` – criteria, score validation and the overall score calculation,
  shared by the Worker and the pages.

## Earlier years (2021–2025)

The results page has an "Alle år" view with charts across every revealed year. Earlier
years come from the old Google spreadsheet through `scripts/import-history.mjs`:

1. In Google Sheets: File → Download → Microsoft Excel (.xlsx). Keep the file outside the repo.
2. `node scripts/import-history.mjs <file.xlsx>` prints what it found and every data fix
   (dates Sheets made of "5.7", 0 meaning "not rated", values outside 1–11, copied
   descriptions) and writes `.wrangler/import-history.sql` (gitignored).
3. Open the site once so the Worker has migrated the database, then load the SQL:
   - local: `npx wrangler d1 execute DB --local --env dev --file .wrangler/import-history.sql`
   - production: `npx wrangler d1 execute DB --remote --file .wrangler/import-history.sql`

The SQL replaces those years completely, so it is safe to run again. Overall scores are
recomputed from everyone's scores, not taken from the sheet's "Snitt" column, which divides
by the wrong number of people in several years. Beer names are cleaned up in `BEER_NAMES`
in the script, so the same beer gets the same name across years.

## Cloudflare setup

The Worker needs these as type **Secret** (dashboard or `npx wrangler secret put <NAME>`).
Without all three the API answers 500 and nobody can log in.

| Secret | What |
| --- | --- |
| `GROUP_CODE` | Code everyone uses to get in |
| `ADMIN_CODE` | Code for the admin (reveals results, deletes things). Must differ from `GROUP_CODE` |
| `SESSION_SECRET` | At least 32 random characters, e.g. `openssl rand -base64 32` |

The D1 database (`christmas-beer`) is created by wrangler on the first deploy. Changing
`SESSION_SECRET` logs everyone out, which is harmless: they just enter the code again.
Changing a code does not log anyone out; it only affects new logins.
Preview builds have no database or secrets, so their API answers 500 by design.
