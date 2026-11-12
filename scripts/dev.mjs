#!/usr/bin/env node
/**
 * Local development with hot reload: starts Astro (pages, CSS) and the Worker
 * (API, local D1) together. Ctrl+C stops both.
 *
 *   npm run dev            → http://localhost:4321
 *
 * Log in with the codes in .dev.vars (GROUP_CODE for members, ADMIN_CODE for admin).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';

const WORKER_PORT = process.env.WORKER_DEV_PORT ?? '8787';

// wrangler requires the assets folder to exist, even though Astro dev serves the pages.
if (!existsSync('dist')) mkdirSync('dist');

if (!existsSync('.dev.vars')) {
  copyFileSync('.dev.vars.example', '.dev.vars');
  console.log('[dev] Created .dev.vars from .dev.vars.example');
}

const colors = { astro: '\x1b[35m', worker: '\x1b[33m' };
const processes = [];

function start(name, args, env = {}) {
  const p = spawn('npx', args, { env: { ...process.env, ...env }, stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const write = (stream) => (data) => {
    for (const line of data.toString().split('\n')) if (line.trim()) stream.write(prefix + line + '\n');
  };
  p.stdout.on('data', write(process.stdout));
  p.stderr.on('data', write(process.stderr));
  p.on('exit', (code) => {
    console.log(`${prefix}stopped (${code ?? 'signal'})`);
    stop(code ?? 0);
  });
  processes.push(p);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of processes) if (p.exitCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('worker', ['wrangler', 'dev', '--env', 'dev', '--port', WORKER_PORT, '--ip', '127.0.0.1', '--show-interactive-dev-session=false']);
start('astro', ['astro', 'dev'], { WORKER_DEV_PORT: WORKER_PORT });
