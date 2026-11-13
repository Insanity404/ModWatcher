// Builds the download people run instead of cloning the repo: the whole bot bundled into one
// ESM file (Node.js 24 is the only requirement), launchers, docs and third-party licences, zipped.
//
//   node scripts/build-release.mjs               main/local build, version <package.json>+<commit>
//   node scripts/build-release.mjs --tag v1.2.3  versioned build; the tag must match package.json
//
// Writes release/ModWatcher/ (the unzipped folder), release/ModWatcher.zip (or
// ModWatcher-v1.2.3.zip) and release/notes.md (release notes; empty when a tag has no
// CHANGELOG.md section, so the workflow falls back to generated notes).
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'release');
const appName = 'ModWatcher';
const appDir = path.join(outDir, appName);
const repoUrl = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`
  : 'https://github.com/Insanity404/ModWatcher';

// discord.js and ws probe for these optional native add-ons inside try/catch and work without
// them. Never bundle them: a bundle can't carry a .node binary.
const OPTIONAL_NATIVE = ['zlib-sync', 'bufferutil', 'utf-8-validate', 'erlpack'];

const { values: args } = parseArgs({ options: { tag: { type: 'string' } } });
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const commit = currentCommit();

let version;
let zipName;
if (args.tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(args.tag);
  if (!match) fail(`--tag must look like v1.2.3 (got ${args.tag})`);
  if (match[1] !== pkg.version) {
    fail(
      `tag ${args.tag} does not match package.json version ${pkg.version}; bump package.json first`,
    );
  }
  version = match[1];
  zipName = `${appName}-${args.tag}.zip`;
} else {
  version = `${pkg.version}+${commit ? commit.slice(0, 7) : 'local'}`;
  zipName = `${appName}.zip`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: path.join(appDir, 'modwatcher.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: OPTIONAL_NATIVE,
  define: { __MODWATCHER_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS (discord.js, pino, dotenv...) calls require(), which ESM output lacks.
  banner: {
    js: [
      `// Mod Watcher ${version} (${repoUrl}). Bundled dependencies: THIRD_PARTY_LICENSES.txt`,
      "import { createRequire as __modwatcherCreateRequire } from 'node:module';",
      'const require = __modwatcherCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});

const text = {
  'start.cmd': [
    '@echo off',
    'rem Starts Mod Watcher from this folder, so it finds .env and keeps data\\ next to it.',
    'title Mod Watcher',
    'cd /d "%~dp0"',
    'node modwatcher.mjs %*',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'),
  'start.sh': [
    '#!/bin/sh',
    '# Starts Mod Watcher from this folder, so it finds .env and keeps data/ next to it.',
    'cd "$(dirname "$0")" || exit 1',
    'exec node modwatcher.mjs "$@"',
    '',
  ].join('\n'),
  'THIRD_PARTY_LICENSES.txt': thirdPartyLicenses(result.metafile),
};
for (const [name, content] of Object.entries(text)) writeFileSync(path.join(appDir, name), content);
for (const name of ['.env.example', 'README.md', 'LICENSE']) {
  copyFileSync(path.join(root, name), path.join(appDir, name));
}

const files = readdirSync(appDir).sort();
const mtime = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
  : new Date();
const zip = zipFiles(
  files.map((name) => ({
    name: `${appName}/${name}`,
    data: readFileSync(path.join(appDir, name)),
    mode: name.endsWith('.sh') ? 0o755 : 0o644,
  })),
  mtime,
);
writeFileSync(path.join(outDir, zipName), zip);
writeFileSync(path.join(outDir, 'notes.md'), args.tag ? changelogSection(version) : rollingNotes());

const bundleBytes = readFileSync(path.join(appDir, 'modwatcher.mjs')).length;
console.log(`Mod Watcher ${version}`);
console.log(`  bundle  release/${appName}/modwatcher.mjs  ${(bundleBytes / 1024).toFixed(0)} KiB`);
console.log(
  `  zip     release/${zipName}  ${(zip.length / 1024).toFixed(0)} KiB: ${files.join(', ')}`,
);

function fail(message) {
  console.error(`build-release: ${message}`);
  process.exit(1);
}

function currentCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Licence text of every npm package in the bundle (MIT, Apache-2.0 and BSD all require it). */
function thirdPartyLicenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(root, input));
    while (dir.startsWith(root) && dir !== root) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest)) {
        const json = JSON.parse(readFileSync(manifest, 'utf8'));
        if (json.name && json.version) {
          packages.set(`${json.name}@${json.version}`, { dir, json });
          break;
        }
      }
      dir = path.dirname(dir);
    }
  }

  const sections = [...packages.values()]
    .sort((a, b) => a.json.name.localeCompare(b.json.name))
    .map(({ dir, json }) => {
      const licence =
        typeof json.license === 'string' ? json.license : (json.license?.type ?? 'see below');
      const repo = typeof json.repository === 'string' ? json.repository : json.repository?.url;
      const source = json.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, '');
      const noticeFiles = readdirSync(dir).filter((f) =>
        /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i.test(f),
      );
      const body = noticeFiles.length
        ? noticeFiles
            .map((f) => readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim())
            .join('\n\n')
        : `(No licence file ships with this package; its package.json declares ${licence}.)`;
      const rule = '-'.repeat(78);
      return [rule, `${json.name} ${json.version} (${licence})`, source, rule, '', body, '']
        .filter((l) => l !== undefined)
        .join('\n');
    });

  return [
    'Third-party software bundled into modwatcher.mjs',
    '',
    "Mod Watcher's own code is under the WTFPL (see LICENSE). The bundle also contains the",
    `${packages.size} packages below, each used under the licence shown and reproduced in full.`,
    '',
    ...sections,
  ].join('\n');
}

/** CHANGELOG.md's section for a version ("## [1.2.3] - date", "## 1.2.3", "## v1.2.3"), or "". */
function changelogSection(version) {
  const file = path.join(root, 'CHANGELOG.md');
  if (!existsSync(file)) return '';
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${version.replaceAll('.', '\\.')}\\]?(\\s|\\(|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return '';
  const next = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  const section = lines.slice(start + 1, next === -1 ? undefined : next);
  return `${section
    .filter((line) => !/^\[[^\]]+\]:\s/.test(line))
    .join('\n')
    .trim()}\n`;
}

/** Notes for the rolling release that main refreshes on every push. */
function rollingNotes() {
  const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const from = commit
    ? `commit [${commit.slice(0, 7)}](${repoUrl}/commit/${commit})`
    : 'a local build';
  return [
    `Rolling build of \`main\`, rebuilt on every push: version **${version}**, from ${from}, built ${built} UTC.`,
    '',
    `**Download \`${appName}.zip\` below.** This link always serves the newest build: <${repoUrl}/releases/latest/download/${appName}.zip>`,
    '',
    'Needs [Node.js 24](https://nodejs.org/). Unzip, copy `.env.example` to `.env`, fill in `DISCORD_TOKEN` and `FEED_KEY`, then run `start.cmd` (Windows) or `./start.sh` (Linux/macOS). To update, extract the new zip over the same folder: `.env` and `data/` are kept.',
    '',
    `Fixed versions (\`v1.2.3\`) are kept on the [Releases page](${repoUrl}/releases). This release's \`build-…\` tag is replaced on every push.`,
    '',
  ].join('\n');
}

/** A minimal zip writer (deflate, Unix modes so start.sh stays executable), no dependencies. */
function zipFiles(entries, date) {
  const dosTime =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    chunks.push(local, fileName, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, spec 2.0: unzip applies the mode below
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); // regular file + permissions
    central.writeUInt32LE(offset, 42);
    directory.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDirectory, end]);
}
