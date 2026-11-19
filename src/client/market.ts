// Direct-from-browser market data.
//
// The client fetches Binance's public REST API (data-api.binance.vision)
// itself instead of going through the artifact's server actions, so the
// same bundle works anywhere it is hosted — including as a plain static
// page (e.g. GitHub Pages) where no `./actions` endpoint exists. Binance
// sends `Access-Control-Allow-Origin: *` on these endpoints, so the
// browser fetch is allowed cross-origin. No API key is required.

import type { Candle } from "./pine";

export type Ticker = {
  symbol: string;
  lastPrice: number;
  changePercent: number;
  high: number;
  low: number;
  quoteVolume: number;
};

const BINANCE = "https://data-api.binance.vision";

type BinanceKline = [
  number, // open time (ms epoch)
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  ...unknown[],
];

type RawTicker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Binance API error (${res.status})`);
  }
  return (await res.json()) as unknown;
}

function mapKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) {
    throw new Error("Unexpected Binance klines response");
  }
  return (raw as BinanceKline[]).map((k) => ({
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/** Recent OHLCV candles for one symbol+interval, including the in-progress candle. */
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<{ candles: Candle[] }> {
  const raw = await fetchJson(
    `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  return { candles: mapKlines(raw) };
}

/**
 * One page of older candles: up to `limit` candles (Binance caps a
 * single klines request at 1000) whose open time is <= `endTime`.
 * Callers pass the earliest loaded candle's time minus 1 and prepend
 * the result, walking back page by page until Binance returns a short
 * page — that means the pair's earliest available candle is reached.
 */
export async function fetchKlinesBefore(
  symbol: string,
  interval: string,
  endTime: number,
  limit: number,
): Promise<{ candles: Candle[] }> {
  const raw = await fetchJson(
    `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&endTime=${endTime}&limit=${limit}`,
  );
  return { candles: mapKlines(raw) };
}

/**
 * Per-interval cap on how many candles a panel will hold in memory.
 * Small timeframes stop at a few thousand recent candles so the
 * browser stays light; larger timeframes may walk back to the very
 * first candle Binance has for the pair.
 */
export const HISTORY_CAPS: Record<string, number> = {
  "1s": 2000,
  "1m": 10000,
  "3m": 10000,
  "5m": 15000,
  "15m": 20000,
  "30m": 30000,
  "1h": 100000,
  "2h": 30000,
  "4h": 20000,
  "6h": 15000,
  "8h": 12000,
  "12h": 10000,
  "1d": 10000,
  "3d": 5000,
  "1w": 2000,
  "1M": 500,
};
export const DEFAULT_HISTORY_CAP = 10000;

/** 24h ticker stats for the given symbols, in the order requested. */
export async function fetchTickers(
  symbols: readonly string[],
): Promise<{ tickers: Ticker[] }> {
  const symbolsParam = encodeURIComponent(JSON.stringify([...symbols]));
  const raw = await fetchJson(
    `${BINANCE}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
  );
  if (!Array.isArray(raw)) {
    throw new Error("Unexpected Binance ticker response");
  }
  const bySymbol = new Map((raw as RawTicker[]).map((t) => [t.symbol, t] as const));
  const tickers = symbols.flatMap((symbol) => {
    const t = bySymbol.get(symbol);
    if (!t) return [];
    return [
      {
        symbol,
        lastPrice: Number(t.lastPrice),
        changePercent: Number(t.priceChangePercent),
        high: Number(t.highPrice),
        low: Number(t.lowPrice),
        quoteVolume: Number(t.quoteVolume),
      },
    ];
  });
  return { tickers };
}
