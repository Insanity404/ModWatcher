import type { Client } from 'discord.js';
import type { BotConfig } from './core/config.js';
import type { Logger } from './core/logger.js';
import type { FeedClient, FeedFailure } from './feed/client.js';
import { updateSignature, type FeedUpdate } from './feed/types.js';
import { postComponents } from './poster/post.js';
import { validateRender } from './render/validate.js';
import type { StateStore } from './state/store.js';

const MAX_POSTS_PER_CYCLE = 5;
const FEED_PAGE_LIMIT = 100;
const FIRST_POLL_DELAY_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const AUTH_RETRY_MS = 60 * 60_000;

export type WatcherStatus = {
  lastPollAt: string | null;
  lastPollOk: boolean;
  lastPostAt: string | null;
  lastProblem: string | null;
  nextPollAt: string | null;
  cursor: string;
};

export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private lastPollAt: string | null = null;
  private lastPollOk = false;
  private lastPostAt: string | null = null;
  private lastProblem: string | null = null;
  private nextPollAt: string | null = null;

  constructor(
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly state: StateStore,
    private readonly feed: FeedClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.schedule(FIRST_POLL_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): WatcherStatus {
    return {
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      lastPostAt: this.lastPostAt,
      lastProblem: this.lastProblem,
      nextPollAt: this.nextPollAt,
      cursor: this.state.cursor,
    };
  }

  private schedule(delayMs: number): void {
    this.nextPollAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    let nextDelayMs = this.config.POLL_INTERVAL_SECONDS * 1000;
    this.lastPollAt = new Date().toISOString();

    try {
      const result = await this.feed.getFeed(this.state.cursor, FEED_PAGE_LIMIT);
      if (!result.ok) {
        this.lastPollOk = false;
        nextDelayMs = this.delayForFailure(result);
      } else {
        this.lastPollOk = true;
        this.lastProblem = null;
        this.consecutiveFailures = 0;
        await this.processUpdates(result.response.updates);
      }
    } catch (error) {
      this.lastPollOk = false;
      this.lastProblem = 'internal error (see log)';
      this.logger.error({ err: error }, 'poll cycle threw');
    }

    this.schedule(nextDelayMs);
  }

  private delayForFailure(failure: FeedFailure): number {
    this.consecutiveFailures += 1;

    if (failure.kind === 'auth') {
      this.lastProblem = 'feed key rejected — check it on 7d2dmodding.com';
      this.logger.error('feed key rejected (revoked or mistyped); retrying hourly');
      return AUTH_RETRY_MS;
    }
    if (failure.kind === 'rateLimited') {
      this.lastProblem = 'feed rate limit reached';
      this.logger.warn({ retryAfterMs: failure.retryAfterMs }, 'feed rate limited');
      return failure.retryAfterMs ?? 60_000;
    }

    this.lastProblem =
      failure.kind === 'disabled' ? 'feed is switched off server-side' : 'feed unreachable';
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS);
    this.logger.info(
      { kind: failure.kind, status: failure.status, retryInMs: delay },
      'feed unavailable, backing off',
    );
    return delay;
  }

  private async processUpdates(updates: FeedUpdate[]): Promise<void> {
    const ordered = [...updates].sort((a, b) => (a.lastUpdateAt < b.lastUpdateAt ? -1 : 1));
    let posted = 0;

    for (const update of ordered) {
      const signature = updateSignature(update);
      if (this.state.hasPosted(signature)) {
        await this.state.advanceCursor(update.lastUpdateAt);
        continue;
      }
      if (posted >= MAX_POSTS_PER_CYCLE) break;

      const render = validateRender(update.render);
      if (!render.ok) {
        this.logger.warn({ id: update.id, reason: render.reason }, 'update skipped: bad render');
        await this.state.recordPosted(signature, update.lastUpdateAt);
        continue;
      }

      for (const binding of this.state.bindings()) {
        const outcome = await postComponents(this.client, binding.channelId, render.components);
        if (outcome !== 'sent') {
          this.logger.warn(
            { guildId: binding.guildId, channelId: binding.channelId, outcome, id: update.id },
            'post not delivered',
          );
        }
      }

      posted += 1;
      this.lastPostAt = new Date().toISOString();
      await this.state.recordPosted(signature, update.lastUpdateAt);
    }
  }
}
