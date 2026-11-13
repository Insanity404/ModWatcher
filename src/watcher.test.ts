import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { pino } from 'pino';
import type { BotConfig } from './core/config.js';
import type { FeedClient, FeedFailure } from './feed/client.js';
import { updateSignature, type FeedEntry, type FeedUpdate } from './feed/types.js';
import type { PostOutcome } from './poster/post.js';
import { StateStore } from './state/store.js';
import { Watcher } from './watcher.js';

const POLL_MS = 300_000;
const CATCH_UP_MS = 15_000;
const RENDER = {
  version: 2,
  components: [{ type: 17, components: [{ type: 10, content: 'Hi' }] }],
};

// Far enough ahead that every update is newer than the cursor a fresh state file starts at.
function update(id: string, minute: number): FeedUpdate {
  const lastUpdateAt = `2099-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return { id, title: `Mod ${id}`, lastUpdateAt, sources: [], render: RENDER };
}

const valid = (u: FeedUpdate): FeedEntry => ({ ok: true, update: u });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'modwatcher-watcher-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A watcher over two bound servers (channels `a` and `b`), a feed that serves `entries` (after
 * answering with each of `failures`, if given), and a poster that answers each channel from its
 * script ('sent' once the script runs out).
 */
async function harness(
  entries: FeedEntry[],
  script: Record<string, PostOutcome[]>,
  options: { hasMore?: boolean; state?: StateStore; failures?: FeedFailure[] } = {},
) {
  const state = options.state ?? (await StateStore.open(path.join(dir, 'state.json')));
  if (!options.state) {
    await state.setBinding('guild-a', 'a');
    await state.setBinding('guild-b', 'b');
  }
  const posts: string[] = [];
  const post = async (_client: Client, channelId: string): Promise<PostOutcome> => {
    posts.push(channelId);
    return script[channelId]?.shift() ?? 'sent';
  };
  const feed = {
    getFeed: async () =>
      options.failures?.shift() ?? {
        ok: true,
        response: { version: 1, generatedAt: '', since: null, hasMore: options.hasMore, entries },
      },
  } as unknown as FeedClient;
  const config = { POLL_INTERVAL_SECONDS: POLL_MS / 1000 } as BotConfig;
  const watcher = new Watcher({} as Client, config, state, feed, pino({ level: 'silent' }), post);
  return { state, watcher, posts };
}

describe('Watcher delivery', () => {
  it('holds an update back for a server whose post failed, without reposting to the others', async () => {
    const first = update('1', 0);
    const { state, watcher, posts } = await harness([valid(first)], { b: ['failed'] });
    const startCursor = state.cursor;

    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.deepEqual(posts, ['a', 'b']);
    assert.equal(state.hasPosted(updateSignature(first)), false);
    assert.equal(state.cursor, startCursor);
    assert.equal(watcher.status().retryingPost, true);

    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.deepEqual(posts, ['a', 'b', 'b']);
    assert.equal(state.hasPosted(updateSignature(first)), true);
    assert.equal(state.cursor, first.lastUpdateAt);
    assert.equal(watcher.status().retryingPost, false);
  });

  it('keeps later updates waiting behind the one being retried', async () => {
    const { watcher, posts } = await harness([valid(update('2', 5)), valid(update('1', 0))], {
      b: ['failed'],
    });

    await watcher.pollOnce();
    assert.deepEqual(posts, ['a', 'b']);
    await watcher.pollOnce();
    assert.deepEqual(posts, ['a', 'b', 'b', 'a', 'b']);
  });

  it('gives up on a server that keeps failing after a few cycles, so the feed moves on', async () => {
    const first = update('1', 0);
    const { state, watcher, posts } = await harness([valid(first), valid(update('2', 1))], {
      b: Array<PostOutcome>(20).fill('failed'),
    });

    let cycles = 0;
    while (!state.hasPosted(updateSignature(first)) && cycles < 20) {
      await watcher.pollOnce();
      cycles += 1;
    }
    assert.equal(cycles, 5);
    assert.equal(posts.filter((channel) => channel === 'a').length, 2);
    assert.equal(posts.filter((channel) => channel === 'b').length, 6);
  });

  it('stops holding later updates back for a server that already ran out of retries', async () => {
    const updates = [0, 1, 2, 3].map((minute) => update(String(minute + 1), minute));
    const { state, watcher, posts } = await harness(updates.map(valid), {
      b: Array<PostOutcome>(40).fill('failed'),
    });

    for (let cycle = 0; cycle < 5; cycle += 1) await watcher.pollOnce();
    for (const u of updates) assert.equal(state.hasPosted(updateSignature(u)), true, u.id);
    assert.equal(posts.filter((channel) => channel === 'a').length, 4);
  });

  it('does not resend a post Discord never answered', async () => {
    const first = update('1', 0);
    const { state, watcher, posts } = await harness([valid(first)], { b: ['unknown'] });
    await watcher.pollOnce();
    await watcher.pollOnce();
    assert.deepEqual(posts, ['a', 'b']);
    assert.equal(state.hasPosted(updateSignature(first)), true);
  });

  it('does not retry a post Discord refused for good', async () => {
    for (const refusal of ['rejected', 'missingChannel', 'missingPermissions'] as const) {
      const first = update(refusal, 0);
      const { state, watcher, posts } = await harness([valid(first)], { b: [refusal] });
      await watcher.pollOnce();
      await watcher.pollOnce();
      assert.deepEqual(posts, ['a', 'b'], refusal);
      assert.equal(state.hasPosted(updateSignature(first)), true, refusal);
      await rm(path.join(dir, 'state.json'));
    }
  });

  it('remembers across a restart which servers already have the update', async () => {
    const first = update('1', 0);
    const before = await harness([valid(first)], { b: ['failed'] });
    await before.watcher.pollOnce();
    assert.deepEqual(before.posts, ['a', 'b']);

    const reopened = await StateStore.open(path.join(dir, 'state.json'));
    const after = await harness([valid(first)], {}, { state: reopened });
    await after.watcher.pollOnce();
    assert.deepEqual(after.posts, ['b']);
    assert.equal(reopened.hasPosted(updateSignature(first)), true);
  });
});

describe('Watcher pacing and ledger', () => {
  it('ledgers an update that breaks the contract and moves past it', async () => {
    const bad: FeedEntry = {
      ok: false,
      id: 'broken',
      lastUpdateAt: '2099-01-01T10:00:00.000Z',
      problem: 'title: Expected string, received number',
    };
    const next = update('2', 5);
    const { state, watcher, posts } = await harness([bad, valid(next)], {});

    await watcher.pollOnce();
    assert.equal(state.hasPosted('broken@2099-01-01T10:00:00.000Z'), true);
    assert.equal(state.hasPosted(updateSignature(next)), true);
    assert.equal(state.cursor, next.lastUpdateAt);
    assert.deepEqual(posts, ['a', 'b']);

    await watcher.pollOnce();
    assert.deepEqual(posts, ['a', 'b']);
  });

  it('polls again soon while behind, but not while a post is being retried', async () => {
    const six = [0, 1, 2, 3, 4, 5].map((minute) => valid(update(String(minute), minute)));
    const capped = await harness(six, {});
    assert.equal(await capped.watcher.pollOnce(), CATCH_UP_MS);
    assert.equal(capped.posts.length, 10);
    await rm(path.join(dir, 'state.json'));

    const truncated = await harness([valid(update('1', 0))], {}, { hasMore: true });
    assert.equal(await truncated.watcher.pollOnce(), CATCH_UP_MS);
    await rm(path.join(dir, 'state.json'));

    const stalled = await harness([valid(update('1', 0))], { a: ['failed'] }, { hasMore: true });
    assert.equal(await stalled.watcher.pollOnce(), POLL_MS);
  });
});

describe('Watcher feed failures', () => {
  it('backs off from a 403 block like any outage, and says what it is in /status', async () => {
    const blocked: FeedFailure = { ok: false, kind: 'unavailable', status: 403 };
    const { watcher } = await harness([], {}, { failures: [{ ...blocked }, { ...blocked }] });

    assert.equal(await watcher.pollOnce(), 30_000);
    assert.match(watcher.status().lastProblem ?? '', /blocked upstream \(HTTP 403\)/);
    assert.equal(await watcher.pollOnce(), 60_000);
    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.equal(watcher.status().lastProblem, null);
  });

  it('keeps the hourly retry for a rejected key, and names an unreadable reply', async () => {
    const { watcher } = await harness(
      [],
      {},
      {
        failures: [
          { ok: false, kind: 'auth', status: 401 },
          { ok: false, kind: 'malformed', status: 200 },
        ],
      },
    );

    assert.equal(await watcher.pollOnce(), 60 * 60_000);
    assert.match(watcher.status().lastProblem ?? '', /key rejected/);
    await watcher.pollOnce();
    assert.match(watcher.status().lastProblem ?? '', /not understood/);
  });
});
