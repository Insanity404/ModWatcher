import type { z } from 'zod';
import type { Logger } from '../core/logger.js';
import { VERSION } from '../version.js';
import {
  feedResponseSchema,
  feedUpdateSchema,
  followResponseSchema,
  renderEnvelopeSchema,
  type FeedEntry,
  type FeedPage,
  type FollowResponse,
  type RenderEnvelope,
} from './types.js';

export type FeedFailure = {
  ok: false;
  kind: 'auth' | 'disabled' | 'rateLimited' | 'unavailable' | 'malformed' | 'notFound';
  status?: number;
  retryAfterMs?: number;
};

export type FeedResult = { ok: true; response: FeedPage } | FeedFailure;
export type RenderResult = { ok: true; response: RenderEnvelope } | FeedFailure;
export type FollowResult = { ok: true; response: FollowResponse } | FeedFailure;

const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = `ModWatcher/${VERSION} (+https://7d2dmodding.com)`;

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
    const result = await this.request(url, feedResponseSchema);
    if (!result.ok) return result;

    const page = result.response;
    return {
      ok: true,
      response: {
        version: page.version,
        generatedAt: page.generatedAt,
        since: page.since,
        hasMore: page.hasMore,
        entries: page.updates.map(toEntry),
      },
    };
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
          'user-agent': USER_AGENT,
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug({ err: error, url: url.pathname }, 'feed request failed to connect');
      return { ok: false, kind: 'unavailable' };
    }

    if (!res.ok) {
      const code = await errorCode(res);
      // The feed rejects a key with 401 `invalid_key`. A 403 without that code comes from whatever
      // sits in front of the feed (a Cloudflare challenge page, a proxy): an outage to wait out,
      // not a key to replace.
      if (res.status === 401 || code === 'invalid_key') {
        return { ok: false, kind: 'auth', status: res.status };
      }
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
      return { ok: false, kind: 'unavailable', status: res.status };
    }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `error` code of a JSON error reply, or null when the body is not JSON (an HTML block page). */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await res.text());
    return isRecord(body) && typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Checks one update on its own. A bad one keeps its id and timestamp when they are readable, so the
 * watcher can ledger it and move past it instead of tripping over it every cycle.
 */
function toEntry(raw: unknown): FeedEntry {
  const parsed = feedUpdateSchema.safeParse(raw);
  if (parsed.success) return { ok: true, update: parsed.data };

  const fields = isRecord(raw) ? raw : {};
  const id =
    typeof fields.id === 'string' || typeof fields.id === 'number' ? String(fields.id) : null;
  const lastUpdateAt =
    typeof fields.lastUpdateAt === 'string' && !Number.isNaN(Date.parse(fields.lastUpdateAt))
      ? fields.lastUpdateAt
      : null;
  const problem = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'update'}: ${issue.message}`)
    .join('; ');
  return { ok: false, id, lastUpdateAt, problem };
}
