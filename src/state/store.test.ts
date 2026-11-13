import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StateStore } from './store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'modwatcher-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the state file', () => {
  it('keeps every one of many overlapping writes, and leaves no temp file behind', async () => {
    const file = path.join(dir, 'state.json');
    const store = await StateStore.open(file);
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i += 1) {
      writes.push(store.setBinding(`guild-${i}`, `channel-${i}`));
      writes.push(
        store.recordPosted(
          `mod_${i}@2099-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          '2099-01-01T00:00:00.000Z',
        ),
      );
    }
    await Promise.all(writes);

    const reopened = await StateStore.open(file);
    assert.equal(reopened.bindings().length, 20);
    assert.equal(reopened.hasPosted('mod_19@2099-01-01T00:00:19.000Z'), true);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('keeps saving after one write fails', async () => {
    // A directory where the state file should be makes the rename fail.
    const blocked = path.join(dir, 'blocked');
    const store = await StateStore.open(path.join(blocked, 'state.json'));
    await rm(path.join(blocked, 'state.json'));
    await mkdir(path.join(blocked, 'state.json'));
    await assert.rejects(store.setBinding('guild-a', 'a'));

    await rm(path.join(blocked, 'state.json'), { recursive: true });
    await store.setBinding('guild-b', 'b');
    const reopened = await StateStore.open(path.join(blocked, 'state.json'));
    assert.deepEqual(
      reopened
        .bindings()
        .map((b) => b.guildId)
        .sort(),
      ['guild-a', 'guild-b'],
    );
  });
});
