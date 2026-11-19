// Liquidity Master — real order-book edition.
//
// A native port of the LuxAlgo-style "Liquidity Master [SimpleAlgo]"
// Pine script (reference: ~/workspace/trading-terminal/liquidity-master-simplealgo.pine),
// with ONE fundamental change the user asked for: the ladder rows are
// NOT estimated from swing/wick pools. They are computed from real
// resting orders — the live spot order books of every exchange whose
// public depth API the browser can reach (Binance, Coinbase, Kraken,
// OKX, Bybit), merged and aggregated into price rows. Everything else
// follows the original: the depth ladder beside price (bids below in
// mint #00FFA3, offers above in pink #FF3D71, longer bar = more resting
// quote value), the biggest row on each side named as the buy/sell wall
// with a dotted line + halo + name/price label, and the LIQUIDITY
// MASTER panel (Sell wall / Buy wall in ATR distance, Balance share
// below vs above, Walls here held/broke record, Read line). The panel
// additionally shows which exchanges actually fed the book and when it
// was last refreshed; an exchange that fails is dropped from the merge
// and named, never silently hidden.
//
// All fetches are direct from the browser (like market.ts) so the same
// bundle works on static hosting; every depth endpoint used here sends
// `Access-Control-Allow-Origin: *` (Kraken echoes the origin), verified
// 2026-11-19. No API key is needed for public depth.

import type { Candle } from "./pine";

export const COL_BID = "#00FFA3";
export const COL_ASK = "#FF3D71";
export const COL_PANEL_TXT = "#D1D4DC";

// Original fixed rules that carry over unchanged.
const ROWS = 80; // rowsIn default
const SPAN_BARS = 300; // spanIn default — ladder covers this many recent bars
const BRIGHT = 3; // bright default → brightMul = 0.4 + 0.2 * 3 = 1.0
const WALL_AT = 0.5; // a wall must hold this share of the biggest row to be tracked for the record
const BROKE_ATR = 0.5; // a close this far past a wall breaks it
const HELD_ATR = 0.5; // a close this far back from a wall means it held
const TEST_BARS = 60; // a test is dropped after this many bars without a verdict
const KEEP_REC = 10; // wall tests remembered

export type DepthLevel = { price: number; qty: number };

export type OrderBookSnapshot = {
  fetchedAt: number;
  /** Exchanges that answered, in display order. */
  sources: string[];
  /** Exchanges that were tried and failed (network, HTTP, bad payload). */
  failed: string[];
  /** Merged resting levels across all answering exchanges (unsorted). */
  bids: DepthLevel[];
  asks: DepthLevel[];
};

export type LadderRow = {
  y0: number;
  y1: number;
  /** Row size relative to the biggest row, 0..1 (smoothed, like the original). */
  t: number;
  /** True when the row sits at/above the last close (offers), false below (bids). */
  above: boolean;
};

export type LiquidityData = {
  /** True when at least one exchange answered. */
  ready: boolean;
  /** True when the merged book put any liquidity inside the ladder range. */
  hasLiquidity: boolean;
  close: number;
  atr: number;
  rows: LadderRow[];
  base: number;
  step: number;
  nrow: number;
  wallUp: { price: number; t: number } | null;
  wallDn: { price: number; t: number } | null;
  nearUp: number | null;
  nearDn: number | null;
  /** Percent of resting liquidity (summed row weights) below price. */
  shareDn: number;
  sources: string[];
  failed: string[];
  fetchedAt: number;
};

// ---------------------------------------------------------------- fetch

async function fetchJsonTimeout(url: string, ms = 9000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function toLevels(raw: unknown): DepthLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: DepthLevel[] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]);
    const qty = Number(row[1]);
    if (Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0) {
      out.push({ price, qty });
    }
  }
  return out;
}

type RawBook = { bids: DepthLevel[]; asks: DepthLevel[] };

async function fetchBinance(symbol: string): Promise<RawBook> {
  const raw = (await fetchJsonTimeout(
    `https://data-api.binance.vision/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`,
  )) as { bids?: unknown; asks?: unknown };
  return { bids: toLevels(raw.bids), asks: toLevels(raw.asks) };
}

async function fetchCoinbase(base: string): Promise<RawBook> {
  // Level 2: the full aggregated book (tens of thousands of levels,
  // ~1 MB for BTC) — the deepest of the five sources.
  const raw = (await fetchJsonTimeout(
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(base)}-USD/book?level=2`,
  )) as { bids?: unknown; asks?: unknown };
  return { bids: toLevels(raw.bids), asks: toLevels(raw.asks) };
}

// Coinbase's book is ~15x the bytes of the others, so it is refreshed
// on a slower cadence (15 s) and reused between the 5 s polls; its
// aggregated depth barely moves between polls. A failed fetch is not
// cached — the next poll retries and reports the failure honestly.
const coinbaseCache = new Map<string, { at: number; book: RawBook }>();
const COINBASE_TTL_MS = 15000;

async function fetchCoinbaseCached(base: string): Promise<RawBook> {
  const hit = coinbaseCache.get(base);
  if (hit && Date.now() - hit.at < COINBASE_TTL_MS) return hit.book;
  const book = await fetchCoinbase(base);
  coinbaseCache.set(base, { at: Date.now(), book });
  return book;
}

async function fetchKraken(base: string): Promise<RawBook> {
  const pair = base === "BTC" ? "XBTUSD" : `${base}USD`;
  const raw = (await fetchJsonTimeout(
    `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(pair)}&count=500`,
  )) as { error?: unknown[]; result?: Record<string, { bids?: unknown; asks?: unknown }> };
  if (Array.isArray(raw.error) && raw.error.length > 0) throw new Error("Kraken error");
  const book = raw.result ? Object.values(raw.result)[0] : undefined;
  if (!book) throw new Error("Kraken: empty result");
  return { bids: toLevels(book.bids), asks: toLevels(book.asks) };
}

async function fetchOkx(base: string): Promise<RawBook> {
  const raw = (await fetchJsonTimeout(
    `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(base)}-USDT&sz=400`,
  )) as { code?: string; data?: { bids?: unknown; asks?: unknown }[] };
  const book = Array.isArray(raw.data) ? raw.data[0] : undefined;
  if (!book) throw new Error("OKX: empty result");
  return { bids: toLevels(book.bids), asks: toLevels(book.asks) };
}

async function fetchBybit(symbol: string): Promise<RawBook> {
  const raw = (await fetchJsonTimeout(
    `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(symbol)}&limit=200`,
  )) as { result?: { b?: unknown; a?: unknown } };
  if (!raw.result) throw new Error("Bybit: empty result");
  return { bids: toLevels(raw.result.b), asks: toLevels(raw.result.a) };
}

/**
 * Fetch the spot order book for a Binance-style symbol (e.g. BTCUSDT)
 * from every exchange with a free public depth API, and merge whatever
 * answers. Never throws: a total failure returns an empty snapshot
 * whose `failed` list names every exchange that was tried.
 */
export async function fetchOrderBook(symbol: string): Promise<OrderBookSnapshot> {
  const base = symbol.replace(/USDT$/, "").replace(/USD$/, "");
  const attempts: { name: string; run: () => Promise<RawBook> }[] = [
    { name: "Binance", run: () => fetchBinance(symbol) },
    { name: "Coinbase", run: () => fetchCoinbaseCached(base) },
    { name: "Kraken", run: () => fetchKraken(base) },
    { name: "OKX", run: () => fetchOkx(base) },
    { name: "Bybit", run: () => fetchBybit(symbol) },
  ];
  const results = await Promise.allSettled(attempts.map((a) => a.run()));
  const sources: string[] = [];
  const failed: string[] = [];
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  results.forEach((r, i) => {
    const name = attempts[i]?.name ?? "?";
    if (r.status === "fulfilled" && (r.value.bids.length > 0 || r.value.asks.length > 0)) {
      sources.push(name);
      bids.push(...r.value.bids);
      asks.push(...r.value.asks);
    } else {
      failed.push(name);
    }
  });
  return { fetchedAt: Date.now(), sources, failed, bids, asks };
}

// ---------------------------------------------------------------- ladder

/** Wilder ATR over the series; returns the last value (NaN-safe). */
function wilderAtr(cs: Candle[], len: number): number {
  if (cs.length === 0) return 0;
  let atr = 0;
  let seeded = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!c) continue;
    const prev = cs[i - 1];
    const tr = i === 0 || !prev
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    if (i < len) {
      atr += tr;
      seeded += 1;
      if (i === len - 1) atr /= Math.max(1, seeded);
    } else {
      atr = (atr * (len - 1) + tr) / len;
    }
  }
  if (seeded > 0 && cs.length <= len) atr /= seeded;
  return atr > 0 ? atr : 0;
}

/** Round a raw row height to a 1/2/5 "nice" step, like a price grid. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nf = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nf * pow;
}

/**
 * Build the ladder from a merged order book, following the original
 * script's geometry: the ladder spans the price range of the last 300
 * bars plus a margin (max of 1.5 slow-ATR or 8% of the span), rows sit
 * on a fixed grid, each row's weight is the resting quote value
 * (price × quantity, summed across exchanges) in that price band,
 * smoothed [0.25, 0.5, 0.25] and normalized by the biggest row.
 */
export function buildLadder(book: OrderBookSnapshot, candlesIn: Candle[]): LiquidityData | null {
  const candles = candlesIn.slice(-2000);
  const last = candles[candles.length - 1];
  if (!last) return null;
  const close = last.close;
  const atr = Math.max(wilderAtr(candles, 14), 0) || close * 0.001;
  const atrG = Math.max(wilderAtr(candles, 50), atr);
  const span = candles.slice(-SPAN_BARS);
  let hh = -Infinity;
  let ll = Infinity;
  for (const c of span) {
    hh = Math.max(hh, c.high);
    ll = Math.min(ll, c.low);
  }
  if (!Number.isFinite(hh) || !Number.isFinite(ll) || hh <= ll) {
    hh = close * 1.01;
    ll = close * 0.99;
  }
  const margin = Math.max(1.5 * atrG, 0.08 * (hh - ll));
  const step = niceStep((hh - ll + 2 * margin) / ROWS);
  const base = Math.floor((ll - margin) / step) * step;
  let nrow = ROWS;
  while (base + nrow * step < hh + margin && nrow < 100) nrow += 1;

  // Aggregate the merged book into rows by resting quote value.
  const raw = new Array<number>(nrow).fill(0);
  const addLevels = (levels: DepthLevel[]) => {
    for (const lv of levels) {
      const r = Math.floor((lv.price - base) / step);
      if (r >= 0 && r < nrow) raw[r] = (raw[r] ?? 0) + lv.price * lv.qty;
    }
  };
  addLevels(book.bids);
  addLevels(book.asks);

  // Smooth exactly like buildRows() in the original, then normalize.
  const smoothed = new Array<number>(nrow).fill(0);
  let peak = 0;
  for (let r = 0; r < nrow; r++) {
    const prev = r > 0 ? (raw[r - 1] ?? 0) : (raw[0] ?? 0);
    const cur = raw[r] ?? 0;
    const nxt = r < nrow - 1 ? (raw[r + 1] ?? 0) : cur;
    const sm = 0.25 * prev + 0.5 * cur + 0.25 * nxt;
    smoothed[r] = sm;
    peak = Math.max(peak, sm);
  }

  const rows: LadderRow[] = [];
  for (let r = 0; r < nrow; r++) {
    const y0 = base + r * step;
    const y1 = y0 + step;
    rows.push({
      y0,
      y1,
      t: peak > 0 ? (smoothed[r] ?? 0) / peak : 0,
      above: (y0 + y1) / 2 >= close,
    });
  }

  // findWalls(), ported: biggest row on each side at least 0.3 ATR from
  // price, the nearest real pool (t >= 0.3) on each side, and the summed
  // weight on each side for the Balance line.
  let wallUp: LiquidityData["wallUp"] = null;
  let wallDn: LiquidityData["wallDn"] = null;
  let nearUp: number | null = null;
  let nearDn: number | null = null;
  let sumUp = 0;
  let sumDn = 0;
  if (peak > 0) {
    for (let r = 0; r < nrow; r++) {
      const mid = base + (r + 0.5) * step;
      const t = (smoothed[r] ?? 0) / peak;
      if (mid >= close + 0.3 * atr) {
        sumUp += t;
        if (!wallUp || t > wallUp.t) wallUp = { price: mid, t };
        if (t >= 0.3 && nearUp === null) nearUp = mid;
      } else if (mid <= close - 0.3 * atr) {
        sumDn += t;
        if (!wallDn || t > wallDn.t) wallDn = { price: mid, t };
        if (t >= 0.3) nearDn = mid;
      }
    }
  }
  const total = sumUp + sumDn;
  return {
    ready: book.sources.length > 0,
    hasLiquidity: total > 0,
    close,
    atr,
    rows,
    base,
    step,
    nrow,
    wallUp,
    wallDn,
    nearUp,
    nearDn,
    shareDn: total > 0 ? (sumDn / total) * 100 : 50,
    sources: book.sources,
    failed: book.failed,
    fetchedAt: book.fetchedAt,
  };
}

// ---------------------------------------------------------------- wall record

export type WallRecord = {
  held: number;
  total: number;
  testing: boolean;
  testSide: 0 | 1 | -1;
};

/**
 * The held/broke score, ported from the original: the biggest wall on
 * each side (at least half the biggest row) is tracked; when price
 * reaches it a test starts; the wall held if price closes 0.5 ATR back
 * from it, broke if price closes 0.5 ATR through it; a test with no
 * verdict after 60 bars is dropped. The last 10 verdicts are kept.
 * Fed with confirmed candles only (the forming candle is skipped).
 */
export class WallTracker {
  private symbol = "";
  private lastTime = 0;
  private barCount = 0;
  private testSide: 0 | 1 | -1 = 0;
  private testP = Number.NaN;
  private testBar = 0;
  private trackedUp: number | null = null;
  private trackedDn: number | null = null;
  private rec: number[] = [];

  private reset(symbol: string) {
    this.symbol = symbol;
    this.lastTime = 0;
    this.barCount = 0;
    this.testSide = 0;
    this.testP = Number.NaN;
    this.testBar = 0;
    this.trackedUp = null;
    this.trackedDn = null;
    this.rec = [];
  }

  update(symbol: string, candles: Candle[], data: LiquidityData): WallRecord {
    if (symbol !== this.symbol) this.reset(symbol);
    if (data.ready) {
      // Refresh the tracked walls from the live book whenever no test
      // is running (the original refreshes every 10 bars; snapshots
      // arrive every few seconds, so refreshing per update is the
      // live-data equivalent).
      if (this.testSide === 0) {
        this.trackedUp = data.wallUp && data.wallUp.t >= WALL_AT ? data.wallUp.price : null;
        this.trackedDn = data.wallDn && data.wallDn.t >= WALL_AT ? data.wallDn.price : null;
      }
      const atr = data.atr;
      // Confirmed candles only: the last one is still forming.
      for (let i = 0; i < candles.length - 1; i++) {
        const c = candles[i];
        if (!c || c.time <= this.lastTime) continue;
        this.lastTime = c.time;
        this.barCount += 1;
        if (this.testSide === 0) {
          if (this.trackedUp !== null && c.high >= this.trackedUp - data.step / 2) {
            this.testSide = 1;
            this.testP = this.trackedUp;
            this.testBar = this.barCount;
            this.trackedUp = null;
          } else if (this.trackedDn !== null && c.low <= this.trackedDn + data.step / 2) {
            this.testSide = -1;
            this.testP = this.trackedDn;
            this.testBar = this.barCount;
            this.trackedDn = null;
          }
        } else {
          const broke = this.testSide === 1
            ? c.close > this.testP + BROKE_ATR * atr
            : c.close < this.testP - BROKE_ATR * atr;
          const held = this.testSide === 1
            ? c.close <= this.testP - HELD_ATR * atr
            : c.close >= this.testP + HELD_ATR * atr;
          if (broke) {
            this.rec.push(0);
            this.testSide = 0;
          } else if (held) {
            this.rec.push(1);
            this.testSide = 0;
          } else if (this.barCount - this.testBar > TEST_BARS) {
            this.testSide = 0;
          }
          if (this.rec.length > KEEP_REC) this.rec.shift();
        }
      }
    }
    return {
      held: this.rec.reduce((a, b) => a + b, 0),
      total: this.rec.length,
      testing: this.testSide !== 0,
      testSide: this.testSide,
    };
  }
}

// ---------------------------------------------------------------- panel text

/** Price formatting like the original's px(): grouped, 2 decimals for majors. */
export function pxPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (Math.abs(v) >= 1) return v.toFixed(3);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

export type LiquidityTexts = {
  upTxt: string;
  dnTxt: string;
  balTxt: string;
  balColor: string;
  recTxt: string;
  read: string;
  readColor: string;
};

/** The panel's words, ported line-for-line from the original script. */
export function liquidityTexts(data: LiquidityData, rec: WallRecord): LiquidityTexts {
  const { wallUp, wallDn, close, atr } = data;
  const dUp = wallUp ? (wallUp.price - close) / atr : Number.NaN;
  const dDn = wallDn ? (close - wallDn.price) / atr : Number.NaN;
  const upTxt = !wallUp
    ? "No wall on the ladder"
    : `${pxPrice(wallUp.price)}, ${dUp.toFixed(1)} ATR above${wallUp.t >= 0.999 ? ", the biggest pool on the ladder" : ""}`;
  const dnTxt = !wallDn
    ? "No wall on the ladder"
    : `${pxPrice(wallDn.price)}, ${dDn.toFixed(1)} ATR below${wallDn.t >= 0.999 ? ", the biggest pool on the ladder" : ""}`;
  const shareDn = data.shareDn;
  const balTxt = !data.hasLiquidity
    ? "Nothing mapped yet"
    : `${Math.round(shareDn)}% of the resting liquidity sits below price, ${Math.round(100 - shareDn)}% above`;
  const balColor = shareDn >= 58 ? COL_BID : shareDn <= 42 ? COL_ASK : COL_PANEL_TXT;
  const recTxt = rec.total === 0
    ? "No wall tested yet"
    : `Walls held ${rec.held} of the last ${rec.total} ${rec.total === 1 ? "test" : "tests"}`;
  const nUpD = data.nearUp !== null ? (data.nearUp - close) / atr : Number.NaN;
  const nDnD = data.nearDn !== null ? (close - data.nearDn) / atr : Number.NaN;
  const nearUp = Number.isFinite(nUpD) && (!Number.isFinite(nDnD) || nUpD <= nDnD);
  const nearIsWall = nearUp
    ? wallUp !== null && data.nearUp !== null && Math.abs(data.nearUp - wallUp.price) < data.step
    : wallDn !== null && data.nearDn !== null && Math.abs(data.nearDn - wallDn.price) < data.step;
  const thick = shareDn >= 58
    ? ", the thicker side is below"
    : shareDn <= 42
      ? ", the thicker side is above"
      : "";
  let read: string;
  let readColor = COL_PANEL_TXT;
  if (rec.testing) {
    read = rec.testSide === 1
      ? `Testing the sell wall now, a close ${BROKE_ATR.toFixed(1)} ATR through it breaks it`
      : `Testing the buy wall now, a close ${BROKE_ATR.toFixed(1)} ATR through it breaks it`;
    readColor = "#FFFFFF";
  } else if (!data.hasLiquidity) {
    read = "Waiting for order book data";
  } else if (data.nearUp === null && data.nearDn === null) {
    read = "Thin on both sides, nothing in the way";
    readColor = nearUp ? COL_ASK : COL_BID;
  } else if (nearUp) {
    read = (nearIsWall
      ? `Sell wall ${nUpD.toFixed(1)} ATR above is the first thing in the way`
      : `Offers ${nUpD.toFixed(1)} ATR above are the first thing in the way, the sell wall is ${dUp.toFixed(1)} ATR up`) + thick;
    readColor = COL_ASK;
  } else {
    read = (nearIsWall
      ? `Buy wall ${nDnD.toFixed(1)} ATR below is the first thing in the way`
      : `Bids ${nDnD.toFixed(1)} ATR below are the first thing in the way, the buy wall is ${dDn.toFixed(1)} ATR down`) + thick;
    readColor = COL_BID;
  }
  return { upTxt, dnTxt, balTxt, balColor, recTxt, read, readColor };
}
