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
 * Cycles a server may keep failing transiently (5xx, network) on an update another server took,
 * before the feed moves on without it. Until then later updates wait too, so no server gets them
 * out of order.
 */
const MAX_DELIVERY_CYCLES = 5;
/**
 * How long an update no server has taken is held without counting its failures. A failure
 * everywhere means Discord, or the way to it, is down, and the backlog waits that out. Held this
 * long, the bot is more likely broken for good, and the cycles count again so it cannot stall
 * forever.
 */
const MAX_HOLD_MS = 24 * 60 * 60_000;
/**
 * The first retry of a failed post comes this soon. A dropped connection or a 5xx can come after
 * Discord made the post, and a resend within the nonce's few minutes returns that post instead of
 * making a second.
 */
const FIRST_RETRY_DELAY_MS = 60_000;
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
   * Servers that used up their retries on an earlier update while another server took it. Holding
   * every later update back for each of them in turn would slow the feed for everyone else to a
   * crawl, so their next failure is given up on straight away, even on an update no server took:
   * the other servers' posts of it may have been refused or never answered. A post that goes
   * through clears the mark.
   */
  private readonly degraded = new Set<string>();
  /** Whether the cycle that just stalled was its update's first try (see FIRST_RETRY_DELAY_MS). */
  private retrySoon = false;
  /**
   * Set by a rate limit and kept until the feed is caught up. The key's hourly budget is shared with
   * the Follow and history buttons, so the rest of a catch-up goes at the poll interval.
   */
  private slowCatchUp = false;

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
         * turns a busy release hour into a backlog that takes all day to clear. After a rate limit,
         * though, the rest of the catch-up keeps the normal interval (see slowCatchUp). A stalled
         * cycle keeps it too: the next one retries a post Discord just failed to take, and only an
         * update's first retry comes sooner.
         */
        if (end === 'capped' || (end === 'drained' && result.response.hasMore === true)) {
          if (!this.slowCatchUp) nextDelayMs = CATCH_UP_DELAY_MS;
        } else if (end === 'drained') {
          this.slowCatchUp = false;
        } else if (end === 'stalled' && this.retrySoon) {
          nextDelayMs = Math.min(nextDelayMs, FIRST_RETRY_DELAY_MS);
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
      this.slowCatchUp = true;
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
    const saved = this.state.deliveryFor(signature);
    const progress = saved ?? { signature, done: [], failures: {} };
    const marks = { facts: markFacts(update), emojis: this.markEmojis };
    const remaining = this.state
      .bindings()
      .filter(({ guildId }) => !progress.done.includes(guildId));
    const failed: typeof remaining = [];

    for (const [index, { guildId, channelId }] of remaining.entries()) {
      const outcome = await this.post(this.client, channelId, components, this.logger, {
        nonce: postNonce(signature, channelId),
        marks,
      });
      const where = { guildId, channelId, id: update.id };

      if (outcome === 'failed') {
        failed.push({ guildId, channelId });
        continue;
      }
      if (outcome === 'sent') {
        progress.reached = true;
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
      // Saved as it goes, so a restart partway through does not post again where it may already be.
      if ((outcome === 'sent' || outcome === 'unknown') && index < remaining.length - 1) {
        await this.state.saveDelivery(progress);
      }
    }

    /*
     * Failures are judged once every server has been tried. Until some server takes the update, in
     * this cycle or an earlier one, the fault is not any one server's but Discord's, or the way to
     * it: the update is held without counting, however long the backlog behind it grows. Only a
     * post that went out counts as taken. A missing permission or channel is mostly known from the
     * cache, without asking Discord at all, and a post never answered may not be there. A server
     * already given up on is not held (see degraded), and past a day of holding, the cycles count
     * again.
     */
    let holding = false;
    if (failed.length && !progress.reached) {
      progress.heldSince ??= new Date().toISOString();
      holding = Date.now() - Date.parse(progress.heldSince) < MAX_HOLD_MS;
    }
    let owed = false;
    for (const { guildId, channelId } of failed) {
      const where = { guildId, channelId, id: update.id };
      if (holding && !this.degraded.has(guildId)) {
        owed = true;
        this.logger.warn(
          { ...where, heldSince: progress.heldSince },
          'post failed and no server has taken it; holding it until one does',
        );
        continue;
      }
      const failures = (progress.failures[guildId] ?? 0) + 1;
      if (failures < MAX_DELIVERY_CYCLES && !this.degraded.has(guildId)) {
        progress.failures[guildId] = failures;
        owed = true;
        this.logger.warn({ ...where, failures }, 'post failed, retrying next cycle');
        continue;
      }
      // Running out after a day of holding an update no server took says nothing against this
      // server in particular, so the next update is held for it again.
      if (progress.reached) this.degraded.add(guildId);
      this.logger.warn(
        { ...where, failures },
        'post kept failing, giving up on it for this server',
      );
      progress.done.push(guildId);
      delete progress.failures[guildId];
    }

    if (owed) await this.state.saveDelivery(progress);
    this.retrySoon = owed && !saved;
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
