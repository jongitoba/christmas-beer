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
with `jul` (member) or `nisse` (admin).

## How it works

- `src/pages/` – static Astro pages in Norwegian: `/` (code and name), `/smaking/`,
  `/resultater/`, `/admin/`. They fetch everything from the API in the browser.
- `worker/index.ts` – the API under `/api/*`, the only thing the Worker handles.
- `worker/db.ts` – D1 schema (created automatically) and queries.
- `worker/session.ts` – signed session cookie.
- `src/lib/score.ts` – criteria, score validation and the overall score calculation,
  shared by the Worker and the pages.

## Cloudflare setup

The Worker needs these as type **Secret** (dashboard or `npx wrangler secret put <NAME>`):

| Secret | What |
| --- | --- |
| `GROUP_CODE` | Code everyone uses to get in |
| `ADMIN_CODE` | Code for the admin (reveals results, deletes things). Must differ from `GROUP_CODE` |
| `SESSION_SECRET` | At least 32 random characters, e.g. `openssl rand -base64 32` |

The D1 database (`christmas-beer`) is created by wrangler on the first deploy. Changing
`SESSION_SECRET` logs everyone out, which is harmless: they just enter the code again.
Changing a code does not log anyone out; it only affects new logins.
Preview builds have no database or secrets, so their API answers 500 by design.
