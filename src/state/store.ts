import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const stateSchema = z.object({
  cursor: z.string(),
  ledger: z.array(z.string()).default([]),
  guilds: z.record(z.object({ channelId: z.string() })).default({}),
});

type StateFile = z.infer<typeof stateSchema>;

const LEDGER_MAX = 500;

export class StateStore {
  private constructor(
    private readonly filePath: string,
    private readonly state: StateFile,
  ) {}

  static async open(filePath: string): Promise<StateStore> {
    let raw: string | null = null;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (raw === null) {
      const store = new StateStore(filePath, {
        cursor: new Date().toISOString(),
        ledger: [],
        guilds: {},
      });
      await store.save();
      return store;
    }

    const parsed = stateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `State file ${filePath} exists but cannot be understood. ` +
          'Delete it to reset (the bot will start from now, without back-posting).',
      );
    }
    return new StateStore(filePath, parsed.data);
  }

  get cursor(): string {
    return this.state.cursor;
  }

  async advanceCursor(to: string): Promise<void> {
    if (to > this.state.cursor) {
      this.state.cursor = to;
      await this.save();
    }
  }

  hasPosted(signature: string): boolean {
    return this.state.ledger.includes(signature);
  }

  async recordPosted(signature: string, cursor: string): Promise<void> {
    this.state.ledger.push(signature);
    if (this.state.ledger.length > LEDGER_MAX) {
      this.state.ledger.splice(0, this.state.ledger.length - LEDGER_MAX);
    }
    if (cursor > this.state.cursor) this.state.cursor = cursor;
    await this.save();
  }

  bindings(): Array<{ guildId: string; channelId: string }> {
    return Object.entries(this.state.guilds).map(([guildId, binding]) => ({
      guildId,
      channelId: binding.channelId,
    }));
  }

  bindingFor(guildId: string): string | null {
    return this.state.guilds[guildId]?.channelId ?? null;
  }

  async setBinding(guildId: string, channelId: string): Promise<void> {
    this.state.guilds[guildId] = { channelId };
    await this.save();
  }

  async clearBinding(guildId: string): Promise<void> {
    if (guildId in this.state.guilds) {
      delete this.state.guilds[guildId];
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}
