// Starter Pine scripts the user can add to a panel with one tap.
// Nothing here is applied by default — a panel shows indicators only
// after the user adds a script, exactly as requested.

import { FVG_ORDER_BLOCKS_CODE } from "./fvg";

export type LibraryScript = {
  name: string;
  description: string;
  code: string;
};

// Moving Average Cloud from LuxAlgo's "Three Bar Reversal Pattern",
// reduced to ONLY the cloud, with the user's TradingView settings:
// Filtering = Moving Average Cloud (Aligned), MA Type HMA, Fast 50,
// Slow 200, bullish #089981 / bearish #f23645. The reversal arrows,
// labels, lines and S/R boxes of the original script are NOT included.
export const MA_CLOUD = {
  label: "MA Cloud LuxAlgo",
  code: `//@version=5
indicator("MA Cloud LuxAlgo", overlay=true)
fastLen = input.int(50, "Fast Length", minval=1, maxval=100)
slowLen = input.int(200, "Slow Length", minval=100)
maType = input.string("HMA", "Tipe MA")
maFast = maType == "SMA" ? ta.sma(close, fastLen) : maType == "EMA" ? ta.ema(close, fastLen) : maType == "RMA" ? ta.rma(close, fastLen) : maType == "WMA" ? ta.wma(close, fastLen) : maType == "VWMA" ? ta.vwma(close, fastLen) : ta.hma(close, fastLen)
maSlow = maType == "SMA" ? ta.sma(close, slowLen) : maType == "EMA" ? ta.ema(close, slowLen) : maType == "RMA" ? ta.rma(close, slowLen) : maType == "WMA" ? ta.wma(close, slowLen) : maType == "VWMA" ? ta.vwma(close, slowLen) : ta.hma(close, slowLen)
bullish = maFast > maSlow
maColor = bullish ? color.green : color.red
pFast = plot(maFast, "MA Fast", color=color.new(maColor, 81), linewidth=1)
pSlow = plot(maSlow, "MA Slow", color=color.new(maColor, 73), linewidth=1)
fill(pFast, pSlow, math.max(maFast, maSlow), math.min(maFast, maSlow), color.new(maColor, bullish ? 99 : 81), color.new(maColor, bullish ? 81 : 99))
`,
};

export const LIBRARY: LibraryScript[] = [
  {
    name: "MA Cloud LuxAlgo (HMA 50/200)",
    description: "Cloud LuxAlgo: HMA 50 vs 200, hijau #089981 / merah #f23645 — tanpa panah reversal",
    code: MA_CLOUD.code,
  },
  {
    name: "FVG Order Blocks [BigBeluga]",
    description: "Port BigBeluga FVG Order Blocks: filter gap 0,5%, maks 6 block/sisi, bullish #14be94 / bearish #C21919, block jebol dihapus",
    code: FVG_ORDER_BLOCKS_CODE,
  },
  {
    name: "EMA Cross 9/21",
    description: "Dua EMA di atas harga + penanda cross",
    code: `//@version=5
indicator("EMA Cross 9/21", overlay=true)
fastLen = input.int(9, "EMA Cepat")
slowLen = input.int(21, "EMA Lambat")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "EMA Cepat", color=color.orange, linewidth=2)
plot(slow, "EMA Lambat", color=color.blue, linewidth=2)
plotshape(ta.crossover(fast, slow), "Golden Cross", style=shape.triangleup, location=location.belowbar, color=color.green, size=size.small)
plotshape(ta.crossunder(fast, slow), "Death Cross", style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)
`,
  },
  {
    name: "RSI 14",
    description: "Relative Strength Index di panel bawah",
    code: `//@version=5
indicator("RSI 14", overlay=false)
len = input.int(14, "Panjang RSI")
r = ta.rsi(close, len)
plot(r, "RSI", color=color.purple, linewidth=2)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
bgcolor(r > 70 ? color.new(color.red, 85) : r < 30 ? color.new(color.green, 85) : na)
`,
  },
  {
    name: "MACD 12/26/9",
    description: "MACD + signal + histogram",
    code: `//@version=5
indicator("MACD 12/26/9", overlay=false)
fastLen = input.int(12, "Fast")
slowLen = input.int(26, "Slow")
sigLen = input.int(9, "Signal")
[macdLine, signalLine, histLine] = ta.macd(close, fastLen, slowLen, sigLen)
plot(histLine, "Histogram", style=plot.style_columns, color=histLine >= 0 ? color.new(color.green, 40) : color.new(color.red, 40))
plot(macdLine, "MACD", color=color.blue, linewidth=2)
plot(signalLine, "Signal", color=color.orange, linewidth=1)
`,
  },
  {
    name: "Bollinger Bands 20/2",
    description: "Basis ± 2 deviasi standar",
    code: `//@version=5
indicator("Bollinger Bands 20/2", overlay=true)
len = input.int(20, "Panjang")
mult = input.float(2.0, "Multiplier")
[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "Basis", color=color.orange)
plot(upper, "Upper", color=color.blue)
plot(lower, "Lower", color=color.blue)
`,
  },
  {
    name: "VWAP Sesi",
    description: "VWAP kumulatif dari awal data tampil",
    code: `//@version=5
indicator("VWAP", overlay=true)
pv = ta.cum(hlc3 * volume)
v = ta.cum(volume)
plot(pv / v, "VWAP", color=color.yellow, linewidth=2)
`,
  },
  {
    name: "Supertrend 10/3",
    description: "Garis tren berbasis ATR",
    code: `//@version=5
indicator("Supertrend 10/3", overlay=true)
factor = input.float(3.0, "Faktor")
period = input.int(10, "Periode ATR")
[st, dir] = ta.supertrend(factor, period)
plot(st, "Supertrend", color=dir < 0 ? color.red : color.green, style=plot.style_linebr, linewidth=2)
`,
  },
  {
    name: "Stochastic 14/3",
    description: "Stochastic %K dan %D",
    code: `//@version=5
indicator("Stochastic 14/3", overlay=false)
kLen = input.int(14, "Panjang %K")
dLen = input.int(3, "Smoothing %D")
k = ta.sma(ta.stoch(close, high, low, kLen), 3)
d = ta.sma(k, dLen)
plot(k, "%K", color=color.blue)
plot(d, "%D", color=color.orange)
hline(80, "Atas", color=color.gray)
hline(20, "Bawah", color=color.gray)
`,
  },
  {
    name: "ATR 14",
    description: "Average True Range — ukuran volatilitas",
    code: `//@version=5
indicator("ATR 14", overlay=false)
len = input.int(14, "Panjang ATR")
plot(ta.atr(len), "ATR", color=color.aqua, linewidth=2)
`,
  },
];

export const BLANK_SCRIPT = `//@version=5
indicator("Indikator Saya", overlay=true)
// Tulis script Pine di sini. Contoh:
// sma20 = ta.sma(close, 20)
// plot(sma20, "SMA 20", color=color.orange)
`;
