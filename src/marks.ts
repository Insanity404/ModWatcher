import { PermissionFlagsBits, type Client, type GuildTextBasedChannel } from 'discord.js';
import type { Logger } from './core/logger.js';

/**
 * The marks 7d2dmodding.com's own posts carry as reactions: made with generative AI, and who installs
 * the mod. The feed publishes the facts beside each render; this bot shows them as reactions when it
 * can, and writes them into the post when it cannot.
 */
export type MarkFacts = {
  aiTags: string[];
  side: 'server' | 'client' | 'both' | null;
  /** An overhaul or a total conversion, whose post may carry a badge line under the title. */
  scale: string | null;
};

/** This application's own emojis for each mark, as reaction identifiers. */
export type MarkEmojis = { ai: string | null; server: string | null; client: string | null };

export const NO_MARK_EMOJIS: MarkEmojis = { ai: null, server: null, client: null };

/** What the application's emojis must be named; uploaded in the Developer Portal under Emojis. */
export const MARK_EMOJI_NAMES = { ai: 'IsAI', server: 'ServerSide', client: 'ClientSide' } as const;

const SIDE_TEXT: Record<NonNullable<MarkFacts['side']>, string> = {
  server: 'Server-side only',
  client: 'Client-side: every player installs it',
  both: 'Server and every player install it',
};

/** Discord's cap on the text across a message's components. */
const MAX_TEXT = 4000;

/**
 * How the badge line 7d2dmodding.com draws under the title of an overhaul or a total conversion
 * begins; the words after it may change. The line is drawn only when the post's settings there show
 * it, while the feed sends the scale either way, so the line itself is what says it is there.
 */
const SCALE_BADGES = new Map([
  ['overhaul', '🧱 **Overhaul**'],
  ['total-conversion', '🌍 **Total conversion**'],
]);

export function markFacts(source: {
  aiTags?: string[] | null;
  side?: string | null;
  scale?: string | null;
}): MarkFacts {
  const side =
    source.side === 'server' || source.side === 'client' || source.side === 'both'
      ? source.side
      : null;
  return { aiTags: source.aiTags ?? [], side, scale: source.scale ?? null };
}

/** The application's mark emojis, or null when they could not be read. */
export async function loadMarkEmojis(
  client: Client<true>,
  logger: Logger,
): Promise<MarkEmojis | null> {
  try {
    const emojis = await client.application.emojis.fetch();
    const find = (name: string) =>
      emojis.find((emoji) => emoji.name?.toLowerCase() === name.toLowerCase())?.identifier ?? null;
    const found: MarkEmojis = {
      ai: find(MARK_EMOJI_NAMES.ai),
      server: find(MARK_EMOJI_NAMES.server),
      client: find(MARK_EMOJI_NAMES.client),
    };
    logger.info(
      { ai: !!found.ai, server: !!found.server, client: !!found.client },
      'mark emojis loaded',
    );
    return found;
  } catch (error) {
    logger.warn(
      { err: error },
      'could not read the application emojis; keeping any in use (none at startup: marks as text)',
    );
    return null;
  }
}

/**
 * The reactions an update's marks need, or null when one of them has no emoji: then the marks are
 * written into the post instead, all together, so a post never shows half its marks one way and
 * half the other.
 */
export function reactionsFor(facts: MarkFacts, emojis: MarkEmojis): string[] | null {
  const needed: Array<string | null> = [];
  if (facts.aiTags.length) needed.push(emojis.ai);
  if (facts.side === 'server' || facts.side === 'both') needed.push(emojis.server);
  if (facts.side === 'client' || facts.side === 'both') needed.push(emojis.client);
  return needed.every((emoji): emoji is string => !!emoji) ? needed : null;
}

/** The marks as one line of small text, or null when the update has none. */
export function marksLine(facts: MarkFacts): string | null {
  const parts: string[] = [];
  if (facts.aiTags.length) parts.push(`Made with generative AI (${facts.aiTags.join(', ')})`);
  if (facts.side) parts.push(SIDE_TEXT[facts.side]);
  return parts.length ? `-# ${parts.join(' · ')}` : null;
}

/** Reacting needs both: Read Message History always, Add Reactions for the first of each emoji. */
export function canReactIn(channel: GuildTextBasedChannel): boolean {
  const me = channel.guild.members.me;
  if (!me) return false;
  return channel
    .permissionsFor(me)
    .has(PermissionFlagsBits.AddReactions | PermissionFlagsBits.ReadMessageHistory);
}

type TextComponent = { type: 10; content: string };

/**
 * The render with the marks line in its text, under the title and the badge when there is one. The
 * render is left as it is when the line would take it past Discord's text cap: a post without its
 * marks beats one Discord refuses.
 */
export function withMarksLine(components: object[], line: string, facts: MarkFacts): object[] {
  const container = components[0] as { components?: object[] } | undefined;
  const children = container?.components;
  if (!children) return components;
  const texts = children.filter(
    (child): child is TextComponent => (child as { type?: unknown }).type === 10,
  );
  const total = texts.reduce((sum, text) => sum + text.content.length, 0);
  const body = texts[0];
  if (!body || total + line.length + 1 > MAX_TEXT) return components;

  const lines = body.content.split('\n');
  const badge = facts.scale ? SCALE_BADGES.get(facts.scale) : undefined;
  const badged = !!badge && !!lines[1]?.startsWith(badge);
  lines.splice(badged ? 2 : 1, 0, line);
  const patched = children.map((child) =>
    child === body ? { ...body, content: lines.join('\n') } : child,
  );
  return [{ ...container, components: patched }, ...components.slice(1)];
}

/** How one post carries its marks in one channel: reactions to add, or the render to send instead. */
export function planMarks(
  channel: GuildTextBasedChannel,
  components: object[],
  facts: MarkFacts,
  emojis: MarkEmojis,
): { components: object[]; reactions: string[] } {
  const reactions = reactionsFor(facts, emojis);
  if (reactions && (!reactions.length || canReactIn(channel))) return { components, reactions };
  const line = marksLine(facts);
  return { components: line ? withMarksLine(components, line, facts) : components, reactions: [] };
}
