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
    downloads: z
      .object({ total: z.number(), delta30: z.number().nullable() })
      .nullish(),
    fileSizeKb: z.number().nullish(),
    endorsements: z.number().nullish(),
    followers: z.number().nullish(),
    render: z.unknown().optional(),
  })
  .passthrough();

export const feedResponseSchema = z
  .object({
    version: z.literal(FEED_VERSION),
    generatedAt: z.string(),
    since: z.string().nullable(),
    updates: z.array(feedUpdateSchema),
  })
  .passthrough();

export const collectionResponseSchema = z
  .object({
    version: z.literal(FEED_VERSION),
    render: z.unknown(),
  })
  .passthrough();

export type FeedUpdate = z.infer<typeof feedUpdateSchema>;
export type FeedResponse = z.infer<typeof feedResponseSchema>;
export type CollectionResponse = z.infer<typeof collectionResponseSchema>;

export function updateSignature(update: FeedUpdate): string {
  return `${update.id}@${update.lastUpdateAt}`;
}
