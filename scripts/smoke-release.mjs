// Runs the built bundle the way a downloader would: alone in an empty folder next to a .env.
// It must load every module and stop at the Discord login with an invalid-token error, and no
// worker thread may start (the logger writes through an in-process stream, never a transport).
// Needs internet: discord.com rejects the fake token. Run after `pnpm build:release`.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Real settings in this shell must never reach the test bot: dotenv does not override them.
const BOT_SETTINGS = ['DISCORD_TOKEN', 'FEED_KEY', 'FEED_URL', 'STATE_PATH', 'STATUS_TEXT'];
const FAKE_ENV = [
  'DISCORD_TOKEN=invalid-token-for-testing',
  `FEED_KEY=arty_${'0'.repeat(32)}`,
  'STATE_PATH=./data/state.json',
  '',
].join('\n');
// Preloaded from a data: URL so the folder holds nothing but the bundle and .env.
const WORKER_PROBE =
  "data:text/javascript,process.on('worker',()=>{process.stderr.write('SMOKE: a worker thread started\\n');process.exitCode=97})";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'release', 'ModWatcher', 'modwatcher.mjs');
if (!existsSync(bundle)) {
  console.error('smoke-release: no bundle yet, run `pnpm build:release` first');
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'modwatcher-smoke-'));
copyFileSync(bundle, path.join(dir, 'modwatcher.mjs'));
writeFileSync(path.join(dir, '.env'), FAKE_ENV);

const env = { ...process.env };
for (const key of [...BOT_SETTINGS, 'LOG_JSON', 'LOG_LEVEL']) delete env[key];
const run = (...args) =>
  spawnSync(process.execPath, ['--import', WORKER_PROBE, 'modwatcher.mjs', ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });

const problems = [];
const versionRun = run('--version');
const version = versionRun.stdout.trim();
if (versionRun.status !== 0 || !version) problems.push(`--version exited ${versionRun.status}`);

const login = run();
const output = `${login.stdout}\n${login.stderr}`;
const checks = [
  [login.status === 1, `expected exit code 1, got ${login.status ?? login.signal}`],
  [output.includes('Mod Watcher starting'), 'no startup line'],
  [/TokenInvalid|invalid token/i.test(output), 'did not stop at the Discord login'],
  [!/Cannot find module|Dynamic require|ERR_MODULE_NOT_FOUND/.test(output), 'a module failed'],
  [!output.includes('SMOKE: a worker thread started'), 'a worker thread started'],
  [existsSync(path.join(dir, 'data', 'state.json')), 'no state file was written'],
];
for (const [ok, problem] of checks) if (!ok) problems.push(problem);

if (problems.length) {
  console.error(output);
  console.error(`smoke-release FAILED (${problems.join('; ')}). Folder kept: ${dir}`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log(`smoke-release OK: ${version} runs alone and stops at the Discord login.`);
