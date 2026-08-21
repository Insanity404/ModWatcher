import type { Logger } from '../core/logger.js';
import {
  collectionResponseSchema,
  feedResponseSchema,
  type CollectionResponse,
  type FeedResponse,
} from './types.js';

export type FeedFailure = {
  ok: false;
  kind: 'auth' | 'disabled' | 'rateLimited' | 'unavailable' | 'malformed' | 'notFound';
  status?: number;
  retryAfterMs?: number;
};

export type FeedResult = { ok: true; response: FeedResponse } | FeedFailure;
export type CollectionResult = { ok: true; response: CollectionResponse } | FeedFailure;

const REQUEST_TIMEOUT_MS = 30_000;

export class FeedClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly logger: Logger,
  ) {}

  async getFeed(since: string, limit: number): Promise<FeedResult> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('since', since);
    url.searchParams.set('limit', String(limit));
    return this.request(url, feedResponseSchema) as Promise<FeedResult>;
  }

  async getCollection(slug: string): Promise<CollectionResult> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/collections/${slug}`);
    return this.request(url, collectionResponseSchema) as Promise<CollectionResult>;
  }

  private async request(
    url: URL,
    schema: typeof feedResponseSchema | typeof collectionResponseSchema,
  ): Promise<FeedResult | CollectionResult> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${this.key}`,
          'user-agent': 'ModWatcher (+https://7d2dmodding.com)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug({ err: error, url: url.pathname }, 'feed request failed to connect');
      return { ok: false, kind: 'unavailable' };
    }

    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', status: res.status };
    if (res.status === 404) return { ok: false, kind: 'notFound', status: 404 };
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      return {
        ok: false,
        kind: 'rateLimited',
        status: 429,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      };
    }
    if (res.status === 503) return { ok: false, kind: 'disabled', status: 503 };
    if (!res.ok) return { ok: false, kind: 'unavailable', status: res.status };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: 'malformed', status: res.status };
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(
        { url: url.pathname, issues: parsed.error.issues.slice(0, 3) },
        'feed response did not match the pinned contract',
      );
      return { ok: false, kind: 'malformed', status: res.status };
    }
    return { ok: true, response: parsed.data } as FeedResult | CollectionResult;
  }
}
