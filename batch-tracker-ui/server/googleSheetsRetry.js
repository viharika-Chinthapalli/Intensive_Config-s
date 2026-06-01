/**
 * Retry transient Google Sheets read quota / rate limit errors (429, RESOURCE_EXHAUSTED, etc.).
 */

function isSheetsQuotaOrRateLimitError(err) {
  const status = err?.response?.status;
  const code = err?.code;
  const msg = String(err?.message || "").toLowerCase();
  const body = err?.response?.data?.error;
  const reasons = [body?.reason, ...(body?.errors || []).map((e) => e?.reason)].filter(Boolean);
  const r = reasons.join(" ").toLowerCase();
  if (status === 429 || code === 429) return true;
  if (msg.includes("quota exceeded") || msg.includes("resource_exhausted") || msg.includes("rate limit")) return true;
  if (r.includes("ratelimitexceeded") || r.includes("resourceexhausted") || r.includes("userratelimitexceeded"))
    return true;
  return false;
}

/**
 * @param {string} label - short label for logs
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withGoogleSheetsQuotaRetry(label, fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseMs = options.baseDelayMs ?? 1200;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSheetsQuotaOrRateLimitError(err) || attempt === maxAttempts) {
        throw err;
      }
      const exp = Math.min(45_000, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 500);
      const wait = exp + jitter;
      console.warn(
        `[sheets-quota-retry] ${label} attempt ${attempt}/${maxAttempts} backing off ${wait}ms — ${err?.message || err}`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}
