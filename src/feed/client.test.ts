import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { pino } from 'pino';
import { VERSION } from '../version.js';
import { FeedClient } from './client.js';

const SINCE = '2026-11-13T00:00:00.000Z';
// What Cloudflare serves in front of a site that blocks the caller (trimmed).
const CLOUDFLARE_BLOCK_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>' +
  '<body><h1>Sorry, you have been blocked</h1><h2>You are unable to access 7d2dmodding.com</h2>' +
  '</body></html>';

const client = () =>
  new FeedClient(
    'https://feed.example.test/api/feed',
    `arty_${'0'.repeat(32)}`,
    pino({ level: 'silent' }),
  );

function reply(status: number, body: string, contentType: string) {
  return mock.method(
    globalThis,
    'fetch',
    async () => new Response(body, { status, headers: { 'content-type': contentType } }),
  );
}

const replyJson = (status: number, value: unknown) =>
  reply(status, JSON.stringify(value), 'application/json');

function update(id: string, lastUpdateAt: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Mod ${id}`, lastUpdateAt, render: { version: 2, components: [] }, ...extra };
}

afterEach(() => mock.restoreAll());

describe('FeedClient.getFeed', () => {
  it('keeps the good updates of a page that also holds bad ones', async () => {
    replyJson(200, {
      version: 1,
      generatedAt: '2026-11-13T04:00:00.000Z',
      since: SINCE,
      hasMore: false,
      updates: [
        update('1', '2026-11-13T01:00:00.000Z'),
        update('2', '2026-11-13T02:00:00.000Z', { title: 42 }),
        { title: 'neither an id nor a timestamp' },
        update('3', '2026-11-13T03:00:00.000Z', { downloads: { total: 'many' } }),
        update('4', '2026-11-13T03:30:00.000Z'),
      ],
    });

    const result = await client().getFeed(SINCE, 100);
    assert.ok(result.ok);
    const entries = result.response.entries;
    assert.equal(entries.length, 5);

    assert.deepEqual(
      entries.map((entry) => (entry.ok ? entry.update.id : null)),
      ['1', null, null, null, '4'],
    );
    const [, badTitle, anonymous, badDownloads] = entries;
    assert.ok(badTitle && !badTitle.ok);
    assert.equal(badTitle.id, '2');
    assert.equal(badTitle.lastUpdateAt, '2026-11-13T02:00:00.000Z');
    assert.match(badTitle.problem, /^title: /);
    assert.ok(anonymous && !anonymous.ok);
    assert.equal(anonymous.id, null);
    assert.equal(anonymous.lastUpdateAt, null);
    assert.ok(badDownloads && !badDownloads.ok);
    assert.equal(badDownloads.id, '3');
    assert.match(badDownloads.problem, /^downloads\.total: /);
    assert.equal(result.response.hasMore, false);
  });

  it('does not take an unreadable timestamp from a bad update', async () => {
    replyJson(200, {
      version: 1,
      generatedAt: SINCE,
      since: SINCE,
      updates: [{ id: 7, lastUpdateAt: 'yesterday-ish' }],
    });

    const result = await client().getFeed(SINCE, 100);
    assert.ok(result.ok);
    const [entry] = result.response.entries;
    assert.ok(entry && !entry.ok);
    assert.equal(entry.id, '7');
    assert.equal(entry.lastUpdateAt, null);
  });

  it('still refuses the whole page when the envelope breaks the contract', async () => {
    replyJson(200, { version: 2, generatedAt: SINCE, since: SINCE, updates: [] });
    assert.deepEqual(await client().getFeed(SINCE, 100), {
      ok: false,
      kind: 'malformed',
      status: 200,
    });

    mock.restoreAll();
    reply(200, CLOUDFLARE_BLOCK_PAGE, 'text/html');
    assert.deepEqual(await client().getFeed(SINCE, 100), {
      ok: false,
      kind: 'malformed',
      status: 200,
    });
  });

  it('names its version in the User-Agent', async () => {
    const fetch = replyJson(200, { version: 1, generatedAt: SINCE, since: SINCE, updates: [] });
    await client().getFeed(SINCE, 100);

    const init = fetch.mock.calls[0]?.arguments[1] as { headers: Record<string, string> };
    assert.equal(init.headers['user-agent'], `ModWatcher/${VERSION} (+https://7d2dmodding.com)`);
  });
});

describe('FeedClient failure kinds', () => {
  it('reads a 401 as a rejected key', async () => {
    replyJson(401, { error: 'invalid_key' });
    assert.deepEqual(await client().getFeed(SINCE, 100), { ok: false, kind: 'auth', status: 401 });
  });

  it('reads an invalid_key reply as a rejected key, whatever the status', async () => {
    replyJson(403, { error: 'invalid_key' });
    assert.deepEqual(await client().getFeed(SINCE, 100), { ok: false, kind: 'auth', status: 403 });
  });

  it('reads a 403 block page as an outage to back off from, not a key problem', async () => {
    reply(403, CLOUDFLARE_BLOCK_PAGE, 'text/html; charset=UTF-8');
    assert.deepEqual(await client().getFeed(SINCE, 100), {
      ok: false,
      kind: 'unavailable',
      status: 403,
    });
  });

  it('reads a JSON 403 without invalid_key the same way', async () => {
    replyJson(403, { error: 'forbidden' });
    assert.deepEqual(await client().getRender('123', 0), {
      ok: false,
      kind: 'unavailable',
      status: 403,
    });
  });

  it('keeps the kill switch and the rate limit apart from outages', async () => {
    replyJson(503, { error: 'feed_disabled' });
    assert.deepEqual(await client().getFeed(SINCE, 100), {
      ok: false,
      kind: 'disabled',
      status: 503,
    });

    mock.restoreAll();
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        }),
    );
    assert.deepEqual(await client().getFeed(SINCE, 100), {
      ok: false,
      kind: 'rateLimited',
      status: 429,
      retryAfterMs: 120_000,
    });
  });
});
