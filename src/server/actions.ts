// Actions for the Trading Terminal.
//
// Market data is pass-through from Binance's public REST API
// (data-api.binance.vision, no key required). Nothing is persisted:
// the client polls getKlines on an interval and merges the in-progress
// candle locally so the charts tick live.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";

export const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "TRXUSDT",
  "LINKUSDT",
  "AVAXUSDT",
] as const;

export const INTERVALS = [
  "1s",
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;

const BINANCE = "https://data-api.binance.vision";

const candle = z.object({
  time: z.number(), // open time, ms epoch (UTC)
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

type BinanceKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  ...unknown[],
];

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Binance API error (${res.status})`);
  }
  return (await res.json()) as unknown;
}

export const Actions = {
  getKlines: defineAction({
    description:
      "Returns recent OHLCV candles for one symbol and interval from Binance (live, includes the in-progress candle).",
    request: z.object({
      symbol: z.enum(SYMBOLS),
      interval: z.enum(INTERVALS),
      limit: z.number().int().min(50).max(500).default(300),
    }),
    response: z.object({
      candles: z.array(candle),
      serverTime: z.number(),
    }),
    async handler(_ctx, args) {
      const raw = await fetchJson(
        `${BINANCE}/api/v3/klines?symbol=${args.symbol}&interval=${args.interval}&limit=${args.limit}`,
      );
      if (!Array.isArray(raw)) {
        throw new Error("Unexpected Binance klines response");
      }
      const candles = (raw as BinanceKline[]).map((k) => ({
        time: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));
      return { candles, serverTime: Date.now() };
    },
  }),

  getTickers: defineAction({
    description:
      "Returns 24h ticker stats (last price, change %, high, low, quote volume) for the terminal's 10 coins.",
    request: z.object({}),
    response: z.object({
      tickers: z.array(
        z.object({
          symbol: z.string(),
          lastPrice: z.number(),
          changePercent: z.number(),
          high: z.number(),
          low: z.number(),
          quoteVolume: z.number(),
        }),
      ),
      serverTime: z.number(),
    }),
    async handler() {
      const symbolsParam = encodeURIComponent(JSON.stringify([...SYMBOLS]));
      const raw = await fetchJson(
        `${BINANCE}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
      );
      if (!Array.isArray(raw)) {
        throw new Error("Unexpected Binance ticker response");
      }
      type RawTicker = {
        symbol: string;
        lastPrice: string;
        priceChangePercent: string;
        highPrice: string;
        lowPrice: string;
        quoteVolume: string;
      };
      const bySymbol = new Map(
        (raw as RawTicker[]).map((t) => [t.symbol, t] as const),
      );
      const tickers = SYMBOLS.flatMap((symbol) => {
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
      return { tickers, serverTime: Date.now() };
    },
  }),
} satisfies ActionsModule;
