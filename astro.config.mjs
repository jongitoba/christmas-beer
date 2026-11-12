// @ts-check
import { defineConfig } from 'astro/config';

// Port of the Worker during `npm run dev` (see scripts/dev.mjs).
const WORKER_DEV = `http://127.0.0.1:${process.env.WORKER_DEV_PORT ?? 8787}`;

// Pure static build. Server logic (login, API) lives in worker/index.ts and runs
// as a Cloudflare Worker (see wrangler.jsonc).
export default defineConfig({
  site: 'https://christmas-beer.jonoba.no',
  output: 'static',
  trailingSlash: 'ignore',
  vite: {
    server: {
      // Dev server only: the API is served by the Worker in `wrangler dev`.
      proxy: { '/api': { target: WORKER_DEV } },
    },
  },
});
