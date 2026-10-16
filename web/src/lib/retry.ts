/**
 * Retry with exponential backoff + full jitter for HTTP 429 (rate limited) responses, e.g. the shared
 * anonymous public fullnode limit. Honors Retry-After when the error carries it. Total wait is capped so a
 * signed price (valid 10 s) is still usable after the retries.
 */
export interface RetryOpts {
  attempts?: number; // total tries (default 4)
  baseMs?: number; // first backoff ceiling (default 250)
  maxMs?: number; // per-wait ceiling (default 2000)
  budgetMs?: number; // total wait budget (default 5000)
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

type ErrLike = { status?: number; response?: { status?: number; headers?: Record<string, string> | Headers }; message?: string };

export function isRateLimited(e: unknown): boolean {
  const x = e as ErrLike;
  if (x?.status === 429 || x?.response?.status === 429) return true;
  return /\b429\b|too many requests|rate.?limit/i.test(String(x?.message ?? e));
}

function retryAfterMs(e: unknown): number | undefined {
  const h = (e as ErrLike)?.response?.headers;
  const v = h ? (typeof (h as Headers).get === "function" ? (h as Headers).get("retry-after") : (h as Record<string, string>)["retry-after"]) : undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

export async function retry429<T>(fn: (attempt: number) => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const { attempts = 4, baseMs = 250, maxMs = 2000, budgetMs = 5000, random = Math.random } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      if (!isRateLimited(e) || i + 1 >= attempts) throw e;
      const ceiling = Math.min(maxMs, baseMs * 2 ** i);
      let wait = Math.floor(random() * ceiling); // full jitter
      const ra = retryAfterMs(e);
      if (ra !== undefined) wait = Math.max(wait, Math.min(ra, maxMs));
      if (waited + wait > budgetMs) throw e;
      waited += wait;
      o.onRetry?.(i + 1, wait, e);
      await sleep(wait);
    }
  }
}
