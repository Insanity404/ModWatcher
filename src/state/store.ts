import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const deliverySchema = z.object({
  signature: z.string(),
  // Servers finished with this update: posted, refused for good, or given up on.
  done: z.array(z.string()),
  // Failed cycles so far, per server still owed the update.
  failures: z.record(z.number()),
});

const stateSchema = z.object({
  cursor: z.string(),
  ledger: z.array(z.string()).default([]),
  guilds: z.record(z.object({ channelId: z.string() })).default({}),
  // An update some servers already have while others hit a transient Discord failure. Kept on disk
  // so a restart mid-retry does not post it twice to the servers that got it.
  delivery: deliverySchema.optional(),
});

type StateFile = z.infer<typeof stateSchema>;
export type Delivery = z.infer<typeof deliverySchema>;

const LEDGER_MAX = 500;

export class StateStore {
  // Every write queues here: overlapping writes would race each other's rename of the file.
  private saving: Promise<void> = Promise.resolve();

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
    if (this.state.delivery?.signature === signature) delete this.state.delivery;
    await this.save();
  }

  /** Retry progress when `signature` is the update being redelivered, otherwise null. */
  deliveryFor(signature: string): Delivery | null {
    return this.state.delivery?.signature === signature ? this.state.delivery : null;
  }

  async saveDelivery(delivery: Delivery): Promise<void> {
    this.state.delivery = delivery;
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

  private save(): Promise<void> {
    const write = this.saving.then(() => this.write());
    // The caller hears about a failed write; the writes queued behind it still run.
    this.saving = write.catch(() => {});
    return write;
  }

  private async write(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
