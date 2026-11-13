import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { pino } from 'pino';
import {
  loadMarkEmojis,
  markFacts,
  marksLine,
  NO_MARK_EMOJIS,
  reactionsFor,
  withMarksLine,
} from './marks.js';

const EMOJIS = { ai: 'IsAI:1', server: 'ServerSide:2', client: 'ClientSide:3' };
// The badge lines as 7d2dmodding.com draws them.
const OVERHAUL_BADGE =
  '🧱 **Overhaul** — reworks large parts of the game; check compatibility before adding other mods.';
const CONVERSION_BADGE =
  '🌍 **Total conversion** — replaces much of the game; best played on its own.';
const post = (body: string) => [
  {
    type: 17,
    components: [
      { type: 12, items: [] },
      { type: 10, content: body },
    ],
  },
];
const bodyOf = (components: object[]) =>
  (components[0] as { components: Array<{ type: number; content?: string }> }).components.find(
    (c) => c.type === 10,
  )?.content ?? '';

describe('the marks an update carries', () => {
  it('read the feed’s facts, ignoring a side this bot does not know', () => {
    assert.deepEqual(markFacts({ aiTags: ['AI Media'], side: 'both', scale: 'overhaul' }), {
      aiTags: ['AI Media'],
      side: 'both',
      scale: 'overhaul',
    });
    assert.deepEqual(markFacts({ side: 'sideways' }), { aiTags: [], side: null, scale: null });
  });

  it('need one reaction per mark, and none for a mod without marks', () => {
    assert.deepEqual(reactionsFor(markFacts({ aiTags: ['AI Media'], side: 'both' }), EMOJIS), [
      'IsAI:1',
      'ServerSide:2',
      'ClientSide:3',
    ]);
    assert.deepEqual(reactionsFor(markFacts({ side: 'client' }), EMOJIS), ['ClientSide:3']);
    assert.deepEqual(reactionsFor(markFacts({}), NO_MARK_EMOJIS), []);
  });

  it('are all written out instead when any of their emojis is missing', () => {
    const partial = { ...EMOJIS, client: null };
    assert.equal(reactionsFor(markFacts({ aiTags: ['AI Media'], side: 'both' }), partial), null);
  });

  it('read as plain words, with no stand-in emoji', () => {
    assert.equal(
      marksLine(markFacts({ aiTags: ['AI-Generated Content', 'AI Media'], side: 'server' })),
      '-# Made with generative AI (AI-Generated Content, AI Media) · Server-side only',
    );
    assert.equal(
      marksLine(markFacts({ side: 'client' })),
      '-# Client-side: every player installs it',
    );
    assert.equal(marksLine(markFacts({ side: 'both' })), '-# Server and every player install it');
    assert.equal(marksLine(markFacts({})), null);
  });
});

describe('the marks line in a post', () => {
  it('goes under the title, or under the badge when the post draws one', () => {
    const plain = withMarksLine(post('## A Mod\n**Author:** x'), '-# marks', markFacts({}));
    assert.equal(bodyOf(plain), '## A Mod\n-# marks\n**Author:** x');

    const badged = withMarksLine(
      post(`## A Mod\n${OVERHAUL_BADGE}\n**Author:** x`),
      '-# marks',
      markFacts({ scale: 'overhaul' }),
    );
    assert.equal(bodyOf(badged), `## A Mod\n${OVERHAUL_BADGE}\n-# marks\n**Author:** x`);

    const converted = withMarksLine(
      post(`## A Mod\n${CONVERSION_BADGE}`),
      '-# marks',
      markFacts({ scale: 'total-conversion' }),
    );
    assert.equal(bodyOf(converted), `## A Mod\n${CONVERSION_BADGE}\n-# marks`);
  });

  it('goes under the title of an overhaul whose post leaves the badge out', () => {
    // The feed sends the scale even when 7d2dmodding.com's settings do not draw the badge.
    const unbadged = withMarksLine(
      post('## A Mod\n**Author:** x\n**Version:** 2'),
      '-# marks',
      markFacts({ scale: 'overhaul' }),
    );
    assert.equal(bodyOf(unbadged), '## A Mod\n-# marks\n**Author:** x\n**Version:** 2');
  });

  it('is left out rather than take the post past Discord’s text cap', () => {
    const full = post(`## A Mod\n${'x'.repeat(3990)}`);
    assert.equal(withMarksLine(full, '-# Server-side only', markFacts({})), full);
  });

  it('leaves the render it was given untouched', () => {
    const original = post('## A Mod\nbody');
    const snapshot = JSON.stringify(original);
    withMarksLine(original, '-# marks', markFacts({}));
    assert.equal(JSON.stringify(original), snapshot);
  });
});

describe('the application’s mark emojis', () => {
  const discord = (fetch: () => Promise<unknown>) =>
    ({ application: { emojis: { fetch } } }) as unknown as Client<true>;
  const logger = pino({ level: 'silent' });

  it('are found by name', async () => {
    const uploaded = discord(async () => [
      { name: 'isai', identifier: 'IsAI:1' },
      { name: 'ServerSide', identifier: 'ServerSide:2' },
    ]);
    assert.deepEqual(await loadMarkEmojis(uploaded, logger), {
      ai: 'IsAI:1',
      server: 'ServerSide:2',
      client: null,
    });
  });

  it('read as nothing at all when Discord cannot list them, so the set in use stays', async () => {
    const failing = discord(async () => {
      throw new Error('503 Service Unavailable');
    });
    assert.equal(await loadMarkEmojis(failing, logger), null);
  });
});
