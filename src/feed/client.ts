import type { z } from 'zod';
import type { Logger } from '../core/logger.js';
import {
  feedResponseSchema,
  followResponseSchema,
  renderEnvelopeSchema,
  type FeedResponse,
  type FollowResponse,
  type RenderEnvelope,
} from './types.js';

export type FeedFailure = {
  ok: false;
  kind: 'auth' | 'disabled' | 'rateLimited' | 'unavailable' | 'malformed' | 'notFound';
  status?: number;
  retryAfterMs?: number;
};

export type FeedResult = { ok: true; response: FeedResponse } | FeedFailure;
export type RenderResult = { ok: true; response: RenderEnvelope } | FeedFailure;
export type FollowResult = { ok: true; response: FollowResponse } | FeedFailure;

const REQUEST_TIMEOUT_MS = 30_000;

export class FeedClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly logger: Logger,
  ) {}

  private endpoint(path: string): URL {
    return new URL(`${this.baseUrl.replace(/\/$/, '')}${path}`);
  }

  async getFeed(since: string, limit: number): Promise<FeedResult> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('since', since);
    url.searchParams.set('limit', String(limit));
    return this.request(url, feedResponseSchema);
  }

  async getCollection(slug: string): Promise<RenderResult> {
    return this.request(this.endpoint(`/collections/${slug}`), renderEnvelopeSchema);
  }

  async getRender(modId: string, page: number): Promise<RenderResult> {
    const url = this.endpoint(`/render/${encodeURIComponent(modId)}`);
    url.searchParams.set('page', String(page));
    return this.request(url, renderEnvelopeSchema);
  }

  async postFollow(
    userId: string,
    targetType: 'mod' | 'author',
    targetId: string,
  ): Promise<FollowResult> {
    return this.request(this.endpoint('/follow'), followResponseSchema, {
      method: 'POST',
      body: { userId, targetType, targetId },
    });
  }

  private async request<S extends z.ZodTypeAny>(
    url: URL,
    schema: S,
    init?: { method?: string; body?: unknown },
  ): Promise<{ ok: true; response: z.infer<S> } | FeedFailure> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.key}`,
          'user-agent': 'ModWatcher (+https://7d2dmodding.com)',
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
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
    return { ok: true, response: parsed.data as z.infer<S> };
  }
}
