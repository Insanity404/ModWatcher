import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markFacts, marksLine, NO_MARK_EMOJIS, reactionsFor, withMarksLine } from './marks.js';

const EMOJIS = { ai: 'IsAI:1', server: 'ServerSide:2', client: 'ClientSide:3' };
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
      post('## A Mod\n🧱 **Overhaul**\n**Author:** x'),
      '-# marks',
      markFacts({ scale: 'overhaul' }),
    );
    assert.equal(bodyOf(badged), '## A Mod\n🧱 **Overhaul**\n-# marks\n**Author:** x');
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
