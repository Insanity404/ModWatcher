import { z } from 'zod';

export const FEED_VERSION = 1;

const sourcePresenceSchema = z
  .object({
    key: z.string(),
    link: z.string(),
    version: z.string().nullish(),
    lastPublishedAt: z.string().nullish(),
  })
  .passthrough();

export const feedUpdateSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    title: z.string(),
    author: z.string().nullish(),
    version: z.string().nullish(),
    publishedAt: z.string().nullish(),
    lastUpdateAt: z.string(),
    summary: z.string().nullish(),
    imageUrl: z.string().nullish(),
    sources: z.array(sourcePresenceSchema).default([]),
    downloads: z.object({ total: z.number(), delta30: z.number().nullable() }).nullish(),
    fileSizeKb: z.number().nullish(),
    endorsements: z.number().nullish(),
    followers: z.number().nullish(),
    // The facts behind the marks (see marks.ts). A server older than these fields omits them, and
    // a value this bot does not know is ignored rather than failing the update.
    aiTags: z.array(z.string()).nullish().catch(null),
    side: z.string().nullish().catch(null),
    scale: z.string().nullish().catch(null),
    contentWarnings: z.array(z.string()).nullish().catch(null),
    render: z.unknown().optional(),
  })
  .passthrough();

const marksSchema = z
  .object({
    aiTags: z.array(z.string()).nullish(),
    side: z.string().nullish(),
    scale: z.string().nullish(),
  })
  .passthrough();

export const feedResponseSchema = z
  .object({
    version: z.literal(FEED_VERSION),
    generatedAt: z.string(),
    since: z.string().nullable(),
    // True when the window held more than `limit` updates, i.e. we are behind and the next page is
    // already waiting. Optional because a server older than this field simply omits it.
    hasMore: z.boolean().optional(),
    // Each update is checked on its own (feed/client.ts), so one that breaks the contract cannot
    // take the rest of the page down with it.
    updates: z.array(z.unknown()),
  })
  .passthrough();

export const renderEnvelopeSchema = z
  .object({
    version: z.literal(FEED_VERSION),
    render: z.unknown(),
    // A page of a mod's post carries the same marks as the post itself.
    marks: marksSchema.nullish().catch(null),
  })
  .passthrough();

export const followResponseSchema = z
  .object({
    following: z.boolean(),
    label: z.string(),
  })
  .passthrough();

export type FeedUpdate = z.infer<typeof feedUpdateSchema>;
export type FeedResponse = z.infer<typeof feedResponseSchema>;
export type RenderEnvelope = z.infer<typeof renderEnvelopeSchema>;
export type FollowResponse = z.infer<typeof followResponseSchema>;

/** One update off a feed page: parsed, or what could still be read of one that breaks the contract. */
export type FeedEntry =
  | { ok: true; update: FeedUpdate }
  | { ok: false; id: string | null; lastUpdateAt: string | null; problem: string };

export type FeedPage = Pick<FeedResponse, 'version' | 'generatedAt' | 'since' | 'hasMore'> & {
  entries: FeedEntry[];
};

export function updateSignature(update: Pick<FeedUpdate, 'id' | 'lastUpdateAt'>): string {
  return `${update.id}@${update.lastUpdateAt}`;
}
