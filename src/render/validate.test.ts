import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRender } from './validate.js';

function problem(payload: unknown): string | null {
  const result = validateRender(payload);
  return result.ok ? null : result.reason;
}

function withButton(button: Record<string, unknown>): unknown {
  return {
    version: 2,
    components: [
      {
        type: 17,
        components: [
          { type: 10, content: 'A mod update' },
          { type: 1, components: [button] },
        ],
      },
    ],
  };
}

function withThumbnail(url: string): unknown {
  return {
    version: 2,
    components: [
      {
        type: 17,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: 'A mod' }],
            accessory: { type: 11, media: { url } },
          },
        ],
      },
    ],
  };
}

describe('validateRender', () => {
  it('accepts a relayable custom_id of exactly 100 characters', () => {
    const customId = `modwatch:follow:mod:${'m'.repeat(80)}`;
    assert.equal(customId.length, 100);
    assert.equal(
      problem(withButton({ type: 2, style: 2, label: 'Follow', custom_id: customId })),
      null,
    );
  });

  it('refuses a custom_id the pattern admits but Discord would reject', () => {
    const follow = `modwatch:follow:author:${'a'.repeat(78)}`;
    const history = `modwatch:hist:${'h'.repeat(90)}:12`;
    for (const customId of [follow, history]) {
      assert.ok(customId.length > 100);
      assert.equal(
        problem(withButton({ type: 2, style: 1, label: 'Next', custom_id: customId })),
        'custom_id too long',
      );
    }
  });

  it('still refuses a custom_id it cannot relay', () => {
    assert.equal(
      problem(withButton({ type: 2, style: 1, label: 'Hi', custom_id: 'someone:else' })),
      'custom_id is not relayable',
    );
  });

  it('checks link urls by parsing them, not by their spelling', () => {
    const link = (url: string) => problem(withButton({ type: 2, style: 5, label: 'Open', url }));
    assert.equal(link('https://7d2dmodding.com/mods/1'), null);
    assert.equal(link('HTTPS://7D2DMODDING.COM/'), null);
    assert.equal(link('http://7d2dmodding.com/'), 'button url must be https');
    assert.equal(link('https//7d2dmodding.com'), 'button url must be https');
    assert.equal(link('javascript:alert(1)'), 'button url must be https');
  });

  it('checks media urls the same way', () => {
    assert.equal(problem(withThumbnail('https://cdn.example.com/a.png')), null);
    assert.equal(problem(withThumbnail('ftp://cdn.example.com/a.png')), 'media url must be https');
    assert.equal(problem(withThumbnail('not a url')), 'media url must be https');
  });
});
