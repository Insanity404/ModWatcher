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
import { postNonce, type PostOptions, type PostOutcome } from './poster/post.js';
import { StateStore } from './state/store.js';
import { Watcher } from './watcher.js';

const POLL_MS = 300_000;
const CATCH_UP_MS = 15_000;
const FIRST_RETRY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
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

const ids = (updates: FeedUpdate[]) => updates.map((u) => u.id);

/**
 * A watcher over bound servers (channels `a` and `b` unless `channels` names others, bound in that
 * order to `guild-a`, `guild-b`, …), a feed that serves `entries` (after answering with each of
 * `failures`, if given), and a poster that answers each channel from its script ('sent' once the
 * script runs out). An Error in a script is thrown, the way the bot stopping right there would end
 * the cycle. `delivered` lists, per channel, the ids of the updates it was sent, in order.
 */
async function harness(
  entries: FeedEntry[],
  script: Record<string, Array<PostOutcome | Error>>,
  options: {
    hasMore?: boolean;
    state?: StateStore;
    failures?: FeedFailure[];
    channels?: string[];
  } = {},
) {
  const state = options.state ?? (await StateStore.open(path.join(dir, 'state.json')));
  if (!options.state) {
    for (const channel of options.channels ?? ['a', 'b']) {
      await state.setBinding(`guild-${channel}`, channel);
    }
  }
  const posts: string[] = [];
  const nonces: Array<string | undefined> = [];
  const delivered: Record<string, string[]> = {};
  const post = async (
    _client: Client,
    channelId: string,
    _components: object[],
    _logger: unknown,
    postOptions: PostOptions = {},
  ): Promise<PostOutcome> => {
    posts.push(channelId);
    nonces.push(postOptions.nonce);
    const outcome = script[channelId]?.shift() ?? 'sent';
    if (outcome instanceof Error) throw outcome;
    if (outcome === 'sent') {
      const entry = entries.find(
        (e) => e.ok && postNonce(updateSignature(e.update), channelId) === postOptions.nonce,
      );
      (delivered[channelId] ??= []).push(entry?.ok ? entry.update.id : '?');
    }
    return outcome;
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
  return { state, watcher, posts, nonces, delivered };
}

/** Polls until every one of `updates` is ledgered, or `maxCycles` have run. */
async function pollUntilPosted(
  watcher: Watcher,
  state: StateStore,
  updates: FeedUpdate[],
  maxCycles = 20,
): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    if (updates.every((u) => state.hasPosted(updateSignature(u)))) return;
    await watcher.pollOnce();
  }
}

describe('Watcher delivery', () => {
  it('holds an update back for a server whose post failed, without reposting to the others', async () => {
    const first = update('1', 0);
    const { state, watcher, posts } = await harness([valid(first)], { b: ['failed'] });
    const startCursor = state.cursor;

    assert.equal(await watcher.pollOnce(), FIRST_RETRY_MS);
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

  it('remembers the servers that got the update when the bot stops partway through', async () => {
    // A post Discord never answered may be there, so it is remembered the same way.
    for (const outcome of ['sent', 'unknown'] as const) {
      const first = update(outcome, 0);
      const before = await harness([valid(first)], {
        a: [outcome],
        b: [new Error('the bot stopped here')],
      });
      await before.watcher.pollOnce();
      assert.deepEqual(before.posts, ['a', 'b'], outcome);

      const reopened = await StateStore.open(path.join(dir, 'state.json'));
      const after = await harness([valid(first)], {}, { state: reopened });
      await after.watcher.pollOnce();
      assert.deepEqual(after.posts, ['b'], outcome);
      assert.equal(reopened.hasPosted(updateSignature(first)), true, outcome);
      await rm(path.join(dir, 'state.json'));
    }
  });

  it('retries a failed post a minute later the first time, while Discord still knows its nonce', async () => {
    const first = update('1', 0);
    const { state, watcher, posts, nonces } = await harness([valid(first)], {
      b: ['failed', 'failed'],
    });

    assert.equal(await watcher.pollOnce(), FIRST_RETRY_MS);
    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.deepEqual(posts, ['a', 'b', 'b', 'b']);
    assert.equal(new Set(nonces.filter((_, i) => posts[i] === 'b')).size, 1);
    assert.equal(state.hasPosted(updateSignature(first)), true);
  });
});

describe('Watcher while Discord is down', () => {
  const backlog = () => Array.from({ length: 12 }, (_, i) => update(String(i + 1), i));

  it('holds the whole backlog while the only server cannot post, then posts it all in order', async () => {
    const updates = backlog();
    const { state, watcher, delivered } = await harness(
      updates.map(valid),
      { a: Array<PostOutcome>(8).fill('failed') },
      { channels: ['a'] },
    );

    for (let cycle = 0; cycle < 8; cycle += 1) await watcher.pollOnce();
    assert.equal(
      updates.some((u) => state.hasPosted(updateSignature(u))),
      false,
    );

    await pollUntilPosted(watcher, state, updates);
    assert.deepEqual(delivered.a, ids(updates));
  });

  it('holds it for every server when all of them are failing', async () => {
    const updates = backlog();
    const { state, watcher, delivered } = await harness(updates.map(valid), {
      a: Array<PostOutcome>(8).fill('failed'),
      b: Array<PostOutcome>(8).fill('failed'),
    });

    for (let cycle = 0; cycle < 8; cycle += 1) await watcher.pollOnce();
    assert.equal(
      updates.some((u) => state.hasPosted(updateSignature(u))),
      false,
    );

    await pollUntilPosted(watcher, state, updates);
    assert.deepEqual(delivered.a, ids(updates));
    assert.deepEqual(delivered.b, ids(updates));
  });

  it('does not take a server that refused the post for one that took it', async () => {
    const updates = [update('1', 0), update('2', 1)];
    const { state, watcher, delivered } = await harness(updates.map(valid), {
      a: Array<PostOutcome>(20).fill('missingPermissions'),
      b: Array<PostOutcome>(8).fill('failed'),
    });

    for (let cycle = 0; cycle < 8; cycle += 1) await watcher.pollOnce();
    assert.equal(state.hasPosted(updateSignature(updates[0]!)), false);

    await pollUntilPosted(watcher, state, updates);
    assert.deepEqual(delivered.b, ids(updates));
  });

  it('does not take a post Discord never answered for one that went out either', async () => {
    const first = update('1', 0);
    const { state, watcher, delivered } = await harness([valid(first)], {
      a: ['unknown'],
      b: Array<PostOutcome>(8).fill('failed'),
    });

    for (let cycle = 0; cycle < 8; cycle += 1) await watcher.pollOnce();
    assert.equal(state.hasPosted(updateSignature(first)), false);

    await pollUntilPosted(watcher, state, [first]);
    assert.deepEqual(delivered.b, ['1']);
  });

  it('still gives up on a server that fails while another takes the posts, without slowing that one', async () => {
    const entries: FeedEntry[] = [];
    // The failing server is tried first, so it is judged only after the healthy one has posted.
    const { state, watcher, posts } = await harness(
      entries,
      { b: Array<PostOutcome>(40).fill('failed') },
      { channels: ['b', 'a'] },
    );

    // One new update a cycle; how many `a` has after each.
    const reachedA: number[] = [];
    for (let cycle = 1; cycle <= 8; cycle += 1) {
      entries.push(valid(update(String(cycle), cycle)));
      await watcher.pollOnce();
      reachedA.push(posts.filter((channel) => channel === 'a').length);
    }
    // The first update waits out b's five cycles; after that `a` gets each in the cycle it arrives.
    assert.deepEqual(reachedA, [1, 1, 1, 1, 5, 6, 7, 8]);
    assert.equal(posts.filter((channel) => channel === 'b').length, 5 + 7);
    for (const entry of entries) {
      assert.ok(entry.ok && state.hasPosted(updateSignature(entry.update)));
    }
  });

  it('does not hold an update for a server already given up on when the other post went unanswered', async () => {
    const entries: FeedEntry[] = [];
    // Discord never answers a's post of the sixth update, so no server took that one.
    const { state, watcher, delivered } = await harness(entries, {
      a: ['sent', 'sent', 'sent', 'sent', 'sent', 'unknown'],
      b: Array<PostOutcome>(40).fill('failed'),
    });

    // One new update a cycle; how many `a` has after each.
    const reachedA: number[] = [];
    for (let cycle = 1; cycle <= 8; cycle += 1) {
      entries.push(valid(update(String(cycle), cycle)));
      await watcher.pollOnce();
      reachedA.push(delivered.a?.length ?? 0);
    }
    // b is given up on at once for the sixth, so the seventh and eighth reach `a` as they arrive.
    assert.deepEqual(reachedA, [1, 1, 1, 1, 5, 5, 6, 7]);
    for (const entry of entries) {
      assert.ok(entry.ok && state.hasPosted(updateSignature(entry.update)));
    }
  });

  it('counts the failures again once an update has been held for a day, across a restart too', async (t) => {
    const first = update('1', 0);
    const failing = () => ({ a: Array<PostOutcome>(40).fill('failed') });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

    const before = await harness([valid(first)], failing(), { channels: ['a'] });
    for (let cycle = 0; cycle < 8; cycle += 1) await before.watcher.pollOnce();
    assert.equal(before.state.hasPosted(updateSignature(first)), false);

    const reopened = await StateStore.open(path.join(dir, 'state.json'));
    const after = await harness([valid(first)], failing(), { state: reopened });
    t.mock.timers.tick(DAY_MS);
    for (let cycle = 0; cycle < 4; cycle += 1) await after.watcher.pollOnce();
    assert.equal(reopened.hasPosted(updateSignature(first)), false);
    await after.watcher.pollOnce();
    assert.equal(reopened.hasPosted(updateSignature(first)), true);
  });

  it('holds the next update for a day as well, then gives it all five cycles', async (t) => {
    const updates = [update('1', 0), update('2', 1)];
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { state, watcher } = await harness(
      updates.map(valid),
      { a: Array<PostOutcome>(40).fill('failed') },
      { channels: ['a'] },
    );
    const posted = () => updates.map((u) => state.hasPosted(updateSignature(u)));

    await watcher.pollOnce();
    t.mock.timers.tick(DAY_MS);
    for (let cycle = 0; cycle < 5; cycle += 1) await watcher.pollOnce();
    assert.deepEqual(posted(), [true, false]);

    // Running out on the first, with no server taking it, is not held against the server.
    for (let cycle = 0; cycle < 8; cycle += 1) await watcher.pollOnce();
    assert.deepEqual(posted(), [true, false]);
    t.mock.timers.tick(DAY_MS);
    for (let cycle = 0; cycle < 4; cycle += 1) await watcher.pollOnce();
    assert.deepEqual(posted(), [true, false]);
    await watcher.pollOnce();
    assert.deepEqual(posted(), [true, true]);
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

    const stalled = await harness(
      [valid(update('1', 0))],
      { a: ['failed', 'failed'] },
      { hasMore: true },
    );
    assert.equal(await stalled.watcher.pollOnce(), FIRST_RETRY_MS);
    assert.equal(await stalled.watcher.pollOnce(), POLL_MS);
  });

  it('catches up at the normal interval after a rate limit, until it is current again', async () => {
    const entries = Array.from({ length: 16 }, (_, i) => valid(update(String(i + 1), i)));
    const failures: FeedFailure[] = [];
    const { watcher } = await harness(entries, {}, { failures });

    assert.equal(await watcher.pollOnce(), CATCH_UP_MS);
    failures.push({ ok: false, kind: 'rateLimited', status: 429, retryAfterMs: 1_000 });
    assert.equal(await watcher.pollOnce(), 1_000);
    // The key's hourly budget is left to the Follow and history buttons.
    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.equal(await watcher.pollOnce(), POLL_MS);
    assert.equal(await watcher.pollOnce(), POLL_MS);

    // Once current, the next backlog drains at the quick pace again.
    entries.push(...Array.from({ length: 6 }, (_, i) => valid(update(String(i + 17), i + 16))));
    assert.equal(await watcher.pollOnce(), CATCH_UP_MS);
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
