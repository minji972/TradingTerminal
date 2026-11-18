# Trading Terminal

Live TradingView-style chart: 10 top coins (BTC, ETH, BNB, SOL, XRP, DOGE, ADA, TRX, LINK, AVAX), timeframes 1 second to 1 month, 1/2/4-pane layouts with per-pane coin/timeframe/indicators. Indicators only via Pine Script you paste yourself — no default indicators, unlimited per chart.

## Open it

Open `index.html` in a browser (this is the built client, `assets/` next to it). No server, no Docker needed for the chart itself.

Note honestly: this app was built as a Muse artifact with a small server for saving layouts/scripts (`src/server/`). On a static host like GitHub Pages that save endpoint (`./actions`) is not available, so layouts/scripts may not persist across reloads. The chart, live Binance data, Pine engine and built-in script library all run in the browser.

## Built-in scripts

Open the ƒx Indicator button in the app. Library includes:

- **MA Cloud LuxAlgo (HMA 50/200)** — bullish #089981 / bearish #f23645, arrows off
- **FVG Order Blocks [BigBeluga]** — filter gap 0.5%, Fair Value Gaps on, max 6 blocks per side, Broken Blocks off, Signals off, bullish #14be94 / bearish #C21919. In this terminal FVG is a port (the Pine engine has no box/array), so blocks are drawn as edge lines + transparent fill; gap-strength gradient and % text from the original are not included.
- EMA Cross 9/21, RSI 14, MACD 12/26/9, Bollinger Bands 20/2, VWAP Sesi, Supertrend 10/3, Stochastic 14/3, ATR 14

Original Pine sources are in `scripts/`:
- `scripts/fvg-order-blocks-bigbeluga.pine` — © BigBeluga, CC BY-NC-SA 4.0
- `scripts/three-bar-reversal-luxalgo.pine` — LuxAlgo Three Bar Reversal Pattern (MA Cloud part used)

## Structure

```
TradingTerminal/
├── index.html            # built client (open this)
├── assets/               # built JS/CSS
├── src/client/           # React client source (App, ChartView, pine.ts, library.ts, fvg.ts)
├── src/server/           # server actions + schema (artifact runtime only, not used on static hosting)
└── scripts/              # original Pine Script sources
```

## Licence & attribution

- FVG Order Blocks © BigBeluga, CC BY-NC-SA 4.0.
- Three Bar Reversal Pattern © LuxAlgo.
- Pine Script® is a registered trademark of TradingView, Inc. This is an independent implementation, not affiliated with TradingView.
- Market data by Binance.
