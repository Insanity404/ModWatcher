import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiscordAPIError, HTTPError, type Client } from 'discord.js';
import { pino } from 'pino';
import { NO_MARK_EMOJIS, type MarkEmojis } from '../marks.js';
import { postComponents, postNonce } from './post.js';

const ROUTE = 'https://discord.com/api/v10/channels/1/messages';
const COMPONENTS = [{ type: 17, components: [{ type: 10, content: '## A Mod\nAn update' }] }];
const QUICK = { retryDelayMs: 1 };

const discordError = (status: number, code: number, message: string) =>
  new DiscordAPIError({ code, message }, code, status, 'POST', ROUTE, {});
const serverError = (status: number) => new HTTPError(status, 'Bad Gateway', 'POST', ROUTE, {});
const networkError = (code = 'ECONNRESET') =>
  Object.assign(new Error(`connect ${code} discord.com`), { code });
const timeoutError = () =>
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => void lines.push(JSON.parse(line)) },
  );
  return { logger, lines };
}

/**
 * A channel whose sends fail with the given errors, in order, then succeed. `canReact` decides the
 * Add Reactions / Read Message History check; every other permission is granted.
 */
function channel(...failures: Error[]) {
  const sent: Array<Record<string, unknown>> = [];
  const reactions: string[] = [];
  const target = {
    sent,
    reactions,
    canReact: true,
    available: true,
    isTextBased: () => true,
    isDMBased: () => false,
    guild: {} as { available: boolean; members: { me: object | null } },
    permissionsFor: () => ({
      has: (bits: bigint) => {
        const reactBits = 1n << 6n; // Add Reactions
        return (bits & reactBits) === 0n || target.canReact;
      },
    }),
    send: async (payload: Record<string, unknown>) => {
      sent.push(payload);
      const failure = failures.shift();
      if (failure) throw failure;
      return { react: async (emoji: string) => void reactions.push(emoji) };
    },
  };
  target.guild = {
    get available() {
      return target.available;
    },
    members: { me: {} },
  };
  return target;
}

function client(channels: Record<string, unknown>, fetch?: (id: string) => Promise<unknown>) {
  return {
    channels: { cache: new Map(Object.entries(channels)), fetch: fetch ?? (async () => null) },
  } as unknown as Client;
}

const text = (payload: Record<string, unknown> | undefined) =>
  JSON.stringify((payload?.components as unknown[]) ?? []);

describe('postComponents', () => {
  it('sends with mentions disabled', async () => {
    const target = channel();
    const outcome = await postComponents(
      client({ c1: target }),
      'c1',
      COMPONENTS,
      capture().logger,
      QUICK,
    );
    assert.equal(outcome, 'sent');
    assert.deepEqual(target.sent[0]?.allowedMentions, { parse: [] });
  });

  it('logs the code and message Discord refuses a post with, and does not send it again', async () => {
    const { logger, lines } = capture();
    const target = channel(discordError(400, 50035, 'Invalid Form Body'));
    const outcome = await postComponents(client({ c2: target }), 'c2', COMPONENTS, logger, QUICK);

    assert.equal(outcome, 'rejected');
    assert.equal(target.sent.length, 1);
    const line = lines.find((l) => l.msg === 'Discord did not take the post');
    assert.equal(line?.code, 50035);
    assert.equal(line?.reason, 'Invalid Form Body');
    assert.equal(line?.status, 400);
  });

  it('tells missing permissions and a deleted channel apart from other refusals', async () => {
    const denied = channel(discordError(403, 50013, 'Missing Permissions'));
    const gone = channel(discordError(404, 10003, 'Unknown Channel'));
    const logger = capture().logger;
    assert.equal(
      await postComponents(client({ c3: denied }), 'c3', COMPONENTS, logger, QUICK),
      'missingPermissions',
    );
    assert.equal(
      await postComponents(client({ c4: gone }), 'c4', COMPONENTS, logger, QUICK),
      'missingChannel',
    );
  });

  it('retries a 5xx or network failure once after a pause', async () => {
    const logger = capture().logger;
    const recovers = channel(serverError(502));
    assert.equal(
      await postComponents(client({ c5: recovers }), 'c5', COMPONENTS, logger, QUICK),
      'sent',
    );
    assert.equal(recovers.sent.length, 2);

    const staysDown = channel(serverError(500), networkError());
    assert.equal(
      await postComponents(client({ c6: staysDown }), 'c6', COMPONENTS, logger, QUICK),
      'failed',
    );
    assert.equal(staysDown.sent.length, 2);
  });

  it('counts a DNS hiccup as temporary, not as a refusal', async () => {
    const target = channel(networkError('EAI_AGAIN'), networkError('EAI_AGAIN'));
    const outcome = await postComponents(
      client({ d1: target }),
      'd1',
      COMPONENTS,
      capture().logger,
      QUICK,
    );
    assert.equal(outcome, 'failed');
    assert.equal(target.sent.length, 2);
  });

  it('sends the same nonce on a retry, so Discord can drop the repeat', async () => {
    const target = channel(serverError(502));
    const nonce = postNonce('mod_1@2026-11-13T00:00:00.000Z', 'n1');
    await postComponents(client({ n1: target }), 'n1', COMPONENTS, capture().logger, {
      ...QUICK,
      nonce,
    });
    assert.equal(target.sent.length, 2);
    assert.equal(target.sent[0]?.nonce, nonce);
    assert.equal(target.sent[1]?.nonce, nonce);
    assert.equal(target.sent[0]?.enforceNonce, true);
    assert.ok(nonce.length <= 25);
    assert.notEqual(postNonce('mod_1@2026-11-13T00:00:00.000Z', 'other-channel'), nonce);
  });

  it('never resends an unanswered post on a later cycle', async () => {
    const withNonce = channel(timeoutError(), timeoutError());
    const nonce = postNonce('mod_2@x', 't1');
    assert.equal(
      await postComponents(client({ t1: withNonce }), 't1', COMPONENTS, capture().logger, {
        ...QUICK,
        nonce,
      }),
      'unknown',
    );
    // One quick retry under the same nonce, then it is left as possibly sent.
    assert.equal(withNonce.sent.length, 2);

    const withoutNonce = channel(timeoutError());
    assert.equal(
      await postComponents(client({ t2: withoutNonce }), 't2', COMPONENTS, capture().logger, QUICK),
      'unknown',
    );
    assert.equal(withoutNonce.sent.length, 1);
  });

  it('waits for a server Discord has not made available yet', async () => {
    const target = channel();
    target.available = false;
    assert.equal(
      await postComponents(client({ u1: target }), 'u1', COMPONENTS, capture().logger, QUICK),
      'failed',
    );
    assert.equal(target.sent.length, 0);
  });

  it('looks a channel up when the cache lacks it', async () => {
    const target = channel();
    const outcome = await postComponents(
      client({}, async () => target),
      'c7',
      COMPONENTS,
      capture().logger,
      QUICK,
    );
    assert.equal(outcome, 'sent');
  });

  it('reports a channel the API calls gone as missing, and stops asking', async () => {
    let lookups = 0;
    const discord = client({}, async () => {
      lookups += 1;
      throw discordError(404, 10003, 'Unknown Channel');
    });
    const logger = capture().logger;
    assert.equal(await postComponents(discord, 'c8', COMPONENTS, logger, QUICK), 'missingChannel');
    assert.equal(await postComponents(discord, 'c8', COMPONENTS, logger, QUICK), 'missingChannel');
    assert.equal(lookups, 1);
  });

  it('treats a lookup Discord could not answer as transient, and asks again next time', async () => {
    let lookups = 0;
    const discord = client({}, async () => {
      lookups += 1;
      throw lookups === 1 ? serverError(503) : networkError('EAI_AGAIN');
    });
    const logger = capture().logger;
    assert.equal(await postComponents(discord, 'c9', COMPONENTS, logger, QUICK), 'failed');
    assert.equal(await postComponents(discord, 'c9', COMPONENTS, logger, QUICK), 'failed');
    assert.equal(lookups, 2);
  });
});

describe('marks on a post', () => {
  const EMOJIS: MarkEmojis = { ai: 'IsAI:1', server: 'ServerSide:2', client: 'ClientSide:3' };
  const facts = { aiTags: ['AI Media'], side: 'server' as const, scale: null };

  it('go on as the application’s own reactions when it may react', async () => {
    const target = channel();
    await postComponents(client({ m1: target }), 'm1', COMPONENTS, capture().logger, {
      ...QUICK,
      marks: { facts, emojis: EMOJIS },
    });
    assert.deepEqual(target.reactions, ['IsAI:1', 'ServerSide:2']);
    assert.doesNotMatch(text(target.sent[0]), /generative AI/);
  });

  it('are written into the post where it may not react', async () => {
    const target = channel();
    target.canReact = false;
    await postComponents(client({ m2: target }), 'm2', COMPONENTS, capture().logger, {
      ...QUICK,
      marks: { facts, emojis: EMOJIS },
    });
    assert.deepEqual(target.reactions, []);
    assert.match(text(target.sent[0]), /Made with generative AI \(AI Media\) · Server-side only/);
  });

  it('are written into the post when the application has no emojis for them', async () => {
    const target = channel();
    await postComponents(client({ m3: target }), 'm3', COMPONENTS, capture().logger, {
      ...QUICK,
      marks: { facts, emojis: NO_MARK_EMOJIS },
    });
    assert.deepEqual(target.reactions, []);
    assert.match(text(target.sent[0]), /Server-side only/);
  });

  it('cost the mark, never the post, when a reaction fails', async () => {
    const target = channel();
    const failing = {
      ...target,
      send: async (payload: Record<string, unknown>) => {
        target.sent.push(payload);
        return {
          react: async () => {
            throw new Error('Unknown Emoji');
          },
        };
      },
    };
    const outcome = await postComponents(
      client({ m4: failing }),
      'm4',
      COMPONENTS,
      capture().logger,
      {
        ...QUICK,
        marks: { facts, emojis: EMOJIS },
      },
    );
    assert.equal(outcome, 'sent');
  });
});
