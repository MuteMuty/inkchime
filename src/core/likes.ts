// The like button (lab#18): a heart with the live count from the lab hub's like API.
// Plain logic: the page hands in fetch, storage and what to do with the result, so
// this can be unit-tested with `node --test`. The heart stays hidden until the counts
// load, and nothing on the page ever waits for them. This browser keeps only its own
// like's receipt (to take it back, on any later day): no cookies, nothing about the visitor.

export const LIKES_API = "https://lab.brightloopapps.com";
export const LIKE_KEY = "inkchime:like";
const PROJECT = "inkchime";
const RECEIPT = /^[0-9a-f]{32}$/;

export interface LikeState {
  /** The counts have loaded, so the heart may show. Until then (or if they never do) it stays hidden. */
  ready: boolean;
  liked: boolean;
  count: number;
  /** A like or unlike is on its way. */
  busy: boolean;
}

export type LikeStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface LikesDeps {
  fetch: typeof fetch;
  /** Where the receipt is kept; null (or one that throws) still likes and unlikes within this page. */
  storage: LikeStore | null;
  /** The lab hub's origin; defaults to LIKES_API. */
  api?: string;
  /** Called on every change once the counts have loaded. */
  onChange(state: LikeState): void;
  /** A short, polite note when a like or unlike didn't go through. */
  onNote(text: string): void;
  /** Give up on a request after this long. */
  timeoutMs?: number;
}

export const likeLabel = (n: number): string => `Like Inkchime, ${n} ${n === 1 ? "like" : "likes"}`;

/** The count as the heart shows it, at most four characters so it fits a small phone's dock: 999, 1.2k, 12k, 1.2M. The label keeps the exact number. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  const [size, unit] = n < 1_000_000 ? [1000, "k"] : [1_000_000, "M"];
  const x = n / size;
  // Rounded down, so it never claims more likes than there are.
  return `${x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)}${unit}`;
}

const NOTES = {
  409: "Someone on this network already liked Inkchime today. Thank you!",
  429: "That's a lot of taps. Try again in a minute.",
  other: "That like didn't go through. Try again later.",
} as const;

/** A JSON body as read here: only ever looked into with type checks. */
type Json = Record<string, unknown> | null;

/** A count from the API, or null if it isn't one. */
function total(data: unknown): number | null {
  const n = (data as { total?: unknown } | null)?.total;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export class Likes {
  readonly state: LikeState = { ready: false, liked: false, count: 0, busy: false };
  private receipt: string | null = null;
  private readonly deps: LikesDeps;

  constructor(deps: LikesDeps) {
    this.deps = deps;
  }

  /** Load the counts. Asked quietly: while the hub's likes are resting it answers 204, not an error. */
  async load(): Promise<void> {
    try {
      const r = await this.call("?quiet=1");
      if (r.status !== 200) return;
      const n = total(r.data?.[PROJECT]);
      if (n === null) return;
      this.receipt = this.stored();
      this.set({ ready: true, liked: !!this.receipt, count: n });
    } catch {
      // Unreachable, slow or junk: the heart just stays hidden.
    }
  }

  /** Like, or unlike with the stored receipt. Shows the result at once and settles on the server's count. */
  async toggle(): Promise<void> {
    if (!this.state.ready || this.state.busy) return;
    const wasLiked = this.state.liked;
    const before = this.state.count;
    const sent = this.receipt;
    this.set({ liked: !wasLiked, count: before + (wasLiked ? -1 : 1), busy: true });
    let status = 0;
    let data: Json = null;
    try {
      ({ status, data } = wasLiked && sent
        ? await this.call(`/${PROJECT}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: sent }) })
        : await this.call(`/${PROJECT}`, { method: "POST" }));
    } catch {
      // Offline or too slow: rolled back below.
    }
    const n = total(data);
    if (wasLiked && (status === 200 || status === 404)) {
      // 404: that like is already gone, so it is gone here too.
      this.remember(null);
      this.set({ liked: false, count: n ?? before - 1, busy: false });
    } else if (!wasLiked && status === 200 && typeof data?.receipt === "string" && RECEIPT.test(data.receipt)) {
      this.remember(data.receipt);
      this.set({ liked: true, count: n ?? before + 1, busy: false });
    } else {
      this.set({ liked: wasLiked, count: n ?? before, busy: false });
      this.deps.onNote(status === 409 || status === 429 ? NOTES[status] : NOTES.other);
    }
  }

  private set(next: Partial<LikeState>): void {
    Object.assign(this.state, next);
    this.state.count = Math.max(this.state.liked ? 1 : 0, this.state.count);
    if (this.state.ready) this.deps.onChange(this.state);
  }

  /** The status and JSON body (null if there is none). Never sends cookies; gives up when the API is slow, body included. */
  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; data: Json }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs ?? 6000);
    try {
      const r = await this.deps.fetch(`${this.deps.api ?? LIKES_API}/api/likes${path}`, { ...init, credentials: "omit", signal: abort.signal });
      return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
    } finally {
      clearTimeout(timer);
    }
  }

  private stored(): string | null {
    try {
      const v = JSON.parse(this.deps.storage?.getItem(LIKE_KEY) ?? "null") as { liked?: unknown; receipt?: unknown } | null;
      return v?.liked === true && typeof v.receipt === "string" && RECEIPT.test(v.receipt) ? v.receipt : null;
    } catch {
      return null;
    }
  }

  private remember(receipt: string | null): void {
    this.receipt = receipt;
    try {
      if (receipt) this.deps.storage?.setItem(LIKE_KEY, JSON.stringify({ liked: true, receipt }));
      else this.deps.storage?.removeItem(LIKE_KEY);
    } catch {
      // Storage refused: this page still remembers it.
    }
  }
}
