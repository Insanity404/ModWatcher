import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DiscordAPIError,
  HTTPError,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { Logger } from '../core/logger.js';
import { NO_MARK_EMOJIS, planMarks, type MarkEmojis, type MarkFacts } from '../marks.js';

/**
 * `rejected`: Discord refused this message (a 4xx), so sending it again cannot succeed.
 * `failed`: a 5xx or network error that outlasted one retry, before Discord took the message; worth
 * another try later.
 * `unknown`: the request went out and no answer came back, so the message may well exist. Sending it
 * again on a later cycle, past the nonce's window, could post it twice, so it is not retried then.
 */
export type PostOutcome =
  'sent' | 'missingChannel' | 'missingPermissions' | 'rejected' | 'failed' | 'unknown';

export type PostOptions = {
  /** Same update, same channel, same nonce: Discord returns the first message instead of a second. */
  nonce?: string;
  marks?: { facts: MarkFacts; emojis: MarkEmojis };
  retryDelayMs?: number;
};

const RETRY_DELAY_MS = 3_000;
// The codes Node and undici put on connection-level errors (ECONNRESET, ENOTFOUND, EAI_AGAIN,
// UND_ERR_SOCKET).
const NETWORK_ERROR_CODE = /^(E[A-Z]+|EAI_[A-Z]+|UND_ERR_[A-Z_]+)$/;
// The request was sent and the answer never came.
const RESPONSE_TIMEOUT_CODE = /^UND_ERR_(HEADERS|BODY)_TIMEOUT$/;

/**
 * Channels Discord reported gone or out of reach, so each update does not ask again. Should access
 * come back, the gateway puts the channel back in the cache, which is checked first.
 */
const unreachable = new Set<string>();

/** Discord keeps a nonce for a few minutes and allows 25 characters. */
export function postNonce(signature: string, channelId: string): string {
  return createHash('sha256').update(`${signature}:${channelId}`).digest('base64url').slice(0, 25);
}

export function resolvePostChannel(
  client: Client,
  channelId: string,
): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel;
}

export function canPostIn(channel: GuildTextBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  const permissions = channel.permissionsFor(me);
  return permissions.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
}

export async function postComponents(
  client: Client,
  channelId: string,
  components: object[],
  logger: Logger,
  options: PostOptions = {},
): Promise<PostOutcome> {
  const channel =
    resolvePostChannel(client, channelId) ?? (await fetchPostChannel(client, channelId, logger));
  if (channel === 'failed') return 'failed';
  if (!channel) return 'missingChannel';
  // A server still unavailable after a Discord outage lists no member for the bot yet.
  if (!channel.guild.available || !channel.guild.members.me) return 'failed';
  if (!canPostIn(channel)) return 'missingPermissions';

  const marks = options.marks ?? {
    facts: { aiTags: [], side: null, scale: null },
    emojis: NO_MARK_EMOJIS,
  };
  const plan = planMarks(channel, components, marks.facts, marks.emojis);
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const message = await channel.send({
        components: plan.components as never,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        ...(options.nonce ? { nonce: options.nonce, enforceNonce: true } : {}),
      });
      for (const emoji of plan.reactions) {
        // A mark that cannot go on costs the mark, never the post.
        await message.react(emoji).catch((error: unknown) => {
          logger.warn({ channelId, emoji, ...details(error) }, 'could not add a mark');
        });
      }
      return 'sent';
    } catch (error) {
      const outcome = classify(error);
      // Within the nonce's few minutes a resend cannot make a second message, so an unanswered
      // send is worth one quick retry too.
      const retryable = outcome === 'failed' || (outcome === 'unknown' && !!options.nonce);
      if (retryable && attempt === 1) {
        logger.info(
          { channelId, ...details(error), retryInMs: retryDelayMs },
          'post failed, retrying once',
        );
        await sleep(retryDelayMs);
        continue;
      }
      logger.warn({ channelId, outcome, ...details(error) }, 'Discord did not take the post');
      return outcome;
    }
  }
}

/**
 * The channel from the API when the cache lacks it: null only when Discord itself says it is gone or
 * out of reach. Anything else is a failed lookup, tried again with the next post.
 */
async function fetchPostChannel(
  client: Client,
  channelId: string,
  logger: Logger,
): Promise<GuildTextBasedChannel | null | 'failed'> {
  if (unreachable.has(channelId)) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && !channel.isDMBased()) return channel;
  } catch (error) {
    logger.warn({ channelId, ...details(error) }, 'could not look up the channel');
    const outcome = classify(error);
    if (outcome !== 'missingChannel' && outcome !== 'missingPermissions') return 'failed';
  }
  unreachable.add(channelId);
  return null;
}

function classify(error: unknown): Exclude<PostOutcome, 'sent'> {
  if (error instanceof DiscordAPIError) {
    if (error.status >= 500 || error.status === 429) return 'failed';
    if (error.code === RESTJSONErrorCodes.UnknownChannel) return 'missingChannel';
    if (
      error.code === RESTJSONErrorCodes.MissingAccess ||
      error.code === RESTJSONErrorCodes.MissingPermissions
    ) {
      return 'missingPermissions';
    }
    return 'rejected';
  }
  if (error instanceof HTTPError) return 'failed';
  if (isResponseTimeout(error)) return 'unknown';
  return isNetworkError(error) ? 'failed' : 'rejected';
}

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isResponseTimeout(error: unknown): boolean {
  return causes(error).some((e) => {
    const code = (e as NodeJS.ErrnoException).code;
    return (
      e.name === 'AbortError' ||
      e.name === 'TimeoutError' ||
      (typeof code === 'string' && RESPONSE_TIMEOUT_CODE.test(code))
    );
  });
}

function isNetworkError(error: unknown): boolean {
  return causes(error).some((e) => {
    const code = (e as NodeJS.ErrnoException).code;
    return typeof code === 'string' && NETWORK_ERROR_CODE.test(code);
  });
}

/** What Discord said: its JSON error code and message when it sent one, else the error itself. */
function details(error: unknown): Record<string, unknown> {
  if (error instanceof DiscordAPIError) {
    return { status: error.status, code: error.code, reason: error.message };
  }
  if (error instanceof HTTPError) return { status: error.status, reason: error.message };
  return { err: error };
}
