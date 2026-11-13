import type { Client } from 'discord.js';
import type { BotConfig } from './core/config.js';
import type { Logger } from './core/logger.js';
import type { FeedClient, FeedFailure } from './feed/client.js';
import { updateSignature, type FeedEntry, type FeedUpdate } from './feed/types.js';
import { markFacts, NO_MARK_EMOJIS, type MarkEmojis } from './marks.js';
import { postComponents, postNonce } from './poster/post.js';
import { validateRender } from './render/validate.js';
import type { StateStore } from './state/store.js';

const MAX_POSTS_PER_CYCLE = 5;
/** Gap between cycles while draining a backlog — long enough to stay polite, short enough to catch up. */
const CATCH_UP_DELAY_MS = 15_000;
/**
 * Cycles a server may keep failing transiently (5xx, network) on one update before the feed moves
 * on without it. Until then later updates wait too, so a short Discord outage delays posts rather
 * than dropping them, and no server gets them out of order.
 */
const MAX_DELIVERY_CYCLES = 5;
const FEED_PAGE_LIMIT = 100;
const FIRST_POLL_DELAY_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const AUTH_RETRY_MS = 60 * 60_000;

/** Why a cycle stopped: the page ran out, the cycle cap was hit, or a server is still owed a post. */
type CycleEnd = 'drained' | 'capped' | 'stalled';

export type WatcherStatus = {
  lastPollAt: string | null;
  lastPollOk: boolean;
  lastPostAt: string | null;
  lastProblem: string | null;
  nextPollAt: string | null;
  retryingPost: boolean;
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
  private retryingPost = false;
  private markEmojis: MarkEmojis = NO_MARK_EMOJIS;
  /**
   * Servers that already used up their retries on an earlier update. Holding every later update back
   * for each of them in turn would slow the feed for everyone else to a crawl, so their next failure
   * is given up on straight away. A post that goes through clears the mark.
   */
  private readonly degraded = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly config: BotConfig,
    private readonly state: StateStore,
    private readonly feed: FeedClient,
    private readonly logger: Logger,
    private readonly post = postComponents,
  ) {}

  start(): void {
    this.schedule(FIRST_POLL_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setMarkEmojis(emojis: MarkEmojis): void {
    this.markEmojis = emojis;
  }

  marks(): MarkEmojis {
    return this.markEmojis;
  }

  status(): WatcherStatus {
    return {
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      lastPostAt: this.lastPostAt,
      lastProblem: this.lastProblem,
      nextPollAt: this.nextPollAt,
      retryingPost: this.retryingPost,
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
    this.schedule(await this.pollOnce());
  }

  /** One cycle: fetch the next page, post what is due, and return the wait before the next one. */
  async pollOnce(): Promise<number> {
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
        const end = await this.processEntries(result.response.entries);
        this.retryingPost = end === 'stalled';
        /*
         * Being behind is not a reason to wait. Either the server told us the window was truncated
         * (`hasMore`) or we stopped early on MAX_POSTS_PER_CYCLE — in both cases the next page is
         * already sitting there, and sleeping the full interval between five-post cycles is what
         * turns a busy release hour into a backlog that takes all day to clear. A stalled cycle
         * keeps the normal interval: the next one retries a post Discord just failed to take.
         */
        if (end === 'capped' || (end === 'drained' && result.response.hasMore === true)) {
          nextDelayMs = CATCH_UP_DELAY_MS;
        }
      }
    } catch (error) {
      this.lastPollOk = false;
      this.lastProblem = 'internal error (see log)';
      this.logger.error({ err: error }, 'poll cycle threw');
    }

    return nextDelayMs;
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

    this.lastProblem = describeOutage(failure);
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS);
    this.logger.info(
      { kind: failure.kind, status: failure.status, retryInMs: delay },
      'feed unavailable, backing off',
    );
    return delay;
  }

  private async processEntries(entries: FeedEntry[]): Promise<CycleEnd> {
    // Oldest first. The server now pages forward for a cursored call, but sorting here too keeps
    // this correct against any ordering it is handed.
    const ordered = [...entries].sort((a, b) => {
      const [x, y] = [entryTime(a), entryTime(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    let posted = 0;

    for (const entry of ordered) {
      if (!entry.ok) {
        await this.skipInvalid(entry);
        continue;
      }
      const { update } = entry;
      const signature = updateSignature(update);
      if (this.state.hasPosted(signature)) {
        await this.state.advanceCursor(update.lastUpdateAt);
        continue;
      }
      if (posted >= MAX_POSTS_PER_CYCLE) return 'capped';

      const render = validateRender(update.render);
      if (!render.ok) {
        this.logger.warn({ id: update.id, reason: render.reason }, 'update skipped: bad render');
        await this.state.recordPosted(signature, update.lastUpdateAt);
        continue;
      }

      posted += 1;
      if (!(await this.deliver(update, signature, render.components))) return 'stalled';
      await this.state.recordPosted(signature, update.lastUpdateAt);
    }
    return 'drained';
  }

  /** An update that breaks the feed contract is skipped and ledgered, the way a bad render is. */
  private async skipInvalid(entry: Extract<FeedEntry, { ok: false }>): Promise<void> {
    const { id, lastUpdateAt, problem } = entry;
    // Without both there is nothing to ledger it under, so it is skipped again on every poll.
    const key =
      id !== null && lastUpdateAt !== null
        ? { signature: updateSignature({ id, lastUpdateAt }), lastUpdateAt }
        : null;
    if (key && this.state.hasPosted(key.signature)) {
      await this.state.advanceCursor(key.lastUpdateAt);
      return;
    }
    this.logger.warn({ id, problem }, 'update skipped: does not match the feed contract');
    if (key) await this.state.recordPosted(key.signature, key.lastUpdateAt);
  }

  /**
   * Posts an update to every bound server. False when a server hit a transient failure and is still
   * owed it: the update stays unrecorded, and the next cycle retries only the servers without it.
   */
  private async deliver(
    update: FeedUpdate,
    signature: string,
    components: object[],
  ): Promise<boolean> {
    const progress = this.state.deliveryFor(signature) ?? { signature, done: [], failures: {} };
    const marks = { facts: markFacts(update), emojis: this.markEmojis };
    let owed = false;

    for (const { guildId, channelId } of this.state.bindings()) {
      if (progress.done.includes(guildId)) continue;
      const outcome = await this.post(this.client, channelId, components, this.logger, {
        nonce: postNonce(signature, channelId),
        marks,
      });
      const where = { guildId, channelId, id: update.id };

      if (outcome === 'failed') {
        const failures = (progress.failures[guildId] ?? 0) + 1;
        if (failures < MAX_DELIVERY_CYCLES && !this.degraded.has(guildId)) {
          progress.failures[guildId] = failures;
          owed = true;
          this.logger.warn({ ...where, failures }, 'post failed, retrying next cycle');
          continue;
        }
        this.degraded.add(guildId);
        this.logger.warn(
          { ...where, failures },
          'post kept failing, giving up on it for this server',
        );
      } else if (outcome === 'sent') {
        this.degraded.delete(guildId);
        this.lastPostAt = new Date().toISOString();
      } else if (outcome === 'unknown') {
        this.logger.warn(
          where,
          'Discord never answered; the post may be there, so it is not resent',
        );
      } else {
        this.logger.warn({ ...where, outcome }, 'post not delivered');
      }
      progress.done.push(guildId);
      delete progress.failures[guildId];
    }

    if (owed) await this.state.saveDelivery(progress);
    return !owed;
  }
}

function entryTime(entry: FeedEntry): string {
  return entry.ok ? entry.update.lastUpdateAt : (entry.lastUpdateAt ?? '');
}

function describeOutage(failure: FeedFailure): string {
  if (failure.kind === 'disabled') return 'feed is switched off server-side';
  if (failure.kind === 'malformed') {
    return 'feed reply not understood — see the log (a Mod Watcher update may be needed)';
  }
  if (failure.status === 403) return 'feed blocked upstream (HTTP 403), not a key problem';
  return 'feed unreachable';
}
