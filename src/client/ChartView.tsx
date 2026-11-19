// Canvas candlestick renderer: candles + volume, overlay plots on the
// price pane, one sub-pane per non-overlay script, crosshair with OHLC
// readout, last-price line. Interaction: drag (mouse or touch) on the
// candle area pans in both directions at once — horizontally it pans
// the candle window left/right, including past the latest candle into
// the empty future space on the right, TradingView-style (the view
// offset may go negative); vertically it translates the visible price
// range up/down WITHOUT changing the price scale (the candles ride
// with the pointer). The vertical shift is stored as a manual range
// with the auto-fit span, so it persists across live refetches until
// the view is reset. Wheel/pinch zooms, the on-chart ‹ › buttons pan
// one step at a time, arrow keys pan, and double-click or the
// "Terbaru" button jumps back to the latest candle. The "Ukur rentang"
// tool measures a date & price range: drag on the chart and it draws
// the range box with the price change, % change, bar count, and
// duration. Dragging vertically on the right-hand price axis rescales
// the price range TradingView-style (up stretches the candles taller,
// down flattens them); while a manual scale is active the main pane
// stops auto-fitting, and the "Skala auto" button, a double-click, or
// Home restores auto scale.
// Pointer handling is attached natively (not via React props) so a drag
// keeps tracking even while live refetches re-render the panel
// mid-gesture.

import { useEffect, useRef, useState } from "react";
import type { Candle, PlotOutput } from "./pine";
import { COL_ASK, COL_BID, pxPrice, type LiquidityData } from "./liquidity";

export type PaneGroup = {
  name: string;
  plots: PlotOutput[];
};

const UP = "#26a69a";
const DOWN = "#ef5350";
const GRID = "rgba(15,23,42,0.05)";
const AXIS_TEXT = "#6b7280";
const AXIS_W = 58;

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtAxis(v: number): string {
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(1).replace(/\.0$/, "");
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(3);
  return v.toFixed(5);
}

/** #RRGGBB + alpha → rgba() string, for the ladder/wall translucency. */
function hexA(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

type View = { count: number; offset: number }; // offset = bars hidden past the right edge; negative = empty future bars shown past the latest candle

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} dtk`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} mnt`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 ? `${hr} jam ${min % 60} mnt` : `${hr} jam`;
  const day = Math.floor(hr / 24);
  return hr % 24 ? `${day} hari ${hr % 24} jam` : `${day} hari`;
}

export type ChartType = "candles" | "heikin" | "renko";

// Heikin Ashi: smoothed candles — HA close is the bar average, HA open
// carries the previous HA midpoint, HA high/low span the real extremes.
export function toHeikinAshi(cs: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = Number.NaN;
  let prevClose = Number.NaN;
  for (const c of cs) {
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = Number.isFinite(prevOpen) ? (prevOpen + prevClose) / 2 : (c.open + c.close) / 2;
    out.push({
      time: c.time,
      open,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      close,
      volume: c.volume,
    });
    prevOpen = open;
    prevClose = close;
  }
  return out;
}

// Renko: fixed-size price bricks (no time axis). Brick size comes from
// the series' average true range so it scales with coin and timeframe,
// then adjusts until the brick count is readable (roughly 12–400).
export function toRenko(cs: Candle[]): Candle[] {
  const first = cs[0];
  if (!first) return [];
  let trSum = 0;
  let trCount = 0;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i];
    const p = cs[i - 1];
    if (!c || !p) continue;
    trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trCount += 1;
  }
  let brick = trCount > 0 ? trSum / trCount : 0;
  if (!(brick > 0)) brick = first.close * 0.002;
  if (!(brick > 0)) return cs;
  const build = (size: number): Candle[] => {
    const out: Candle[] = [];
    let base = Math.floor(first.close / size) * size;
    let vol = 0;
    for (const c of cs) {
      vol += c.volume;
      while (c.close >= base + size) {
        out.push({ time: c.time, open: base, high: base + size, low: base, close: base + size, volume: vol });
        base += size;
        vol = 0;
      }
      while (c.close <= base - size) {
        out.push({ time: c.time, open: base, high: base, low: base - size, close: base - size, volume: vol });
        base -= size;
        vol = 0;
      }
    }
    return out;
  };
  let out = build(brick);
  for (let k = 0; k < 24 && out.length > 400; k++) { brick *= 1.5; out = build(brick); }
  for (let k = 0; k < 24 && out.length > 0 && out.length < 12; k++) { brick /= 1.5; out = build(brick); }
  return out.length > 0 ? out : cs;
}

export function transformCandles(cs: Candle[], type: ChartType): Candle[] {
  if (type === "heikin") return toHeikinAshi(cs);
  if (type === "renko") return toRenko(cs);
  return cs;
}

export function ChartView({
  candles,
  overlayPlots,
  panes,
  height,
  onNeedMore,
  liquidity,
}: {
  candles: Candle[];
  overlayPlots: PlotOutput[];
  panes: PaneGroup[];
  height: number;
  // Called whenever the view sits at the oldest loaded candle, so the
  // parent can page in older history. The parent guards the call
  // (no-op while a page is loading or history is exhausted/capped).
  onNeedMore?: () => void;
  // Liquidity Master (real order book): depth ladder + wall lines,
  // drawn over the main pane when present and ready.
  liquidity?: LiquidityData | null;
}) {
  const needMoreRef = useRef(onNeedMore);
  needMoreRef.current = onNeedMore;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ count: 90, offset: 0 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dataRef = useRef({ candles, overlayPlots, panes, liquidity });
  dataRef.current = { candles, overlayPlots, panes, liquidity };
  const drawRef = useRef<(() => void) | null>(null);
  // Interaction state lives in refs (not effect-local variables) so an
  // in-progress drag survives the effect re-running on live refetches.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  // Drag snapshot for a plot-area drag: horizontal pans the time
  // offset, vertical translates the price range. `center`/`span` are
  // the effective price range at drag start (from the manual scale
  // when one is active, else the padded auto-fit range); center is
  // null when no range is known yet, disabling the vertical part.
  const dragStartRef = useRef<{
    x: number;
    y: number;
    offset: number;
    center: number | null;
    span: number;
  } | null>(null);
  const pinchStartRef = useRef<{ dist: number; count: number } | null>(null);
  const [panned, setPanned] = useState(false);
  const pannedRef = useRef(false);
  // Manual price range for the main pane. Created either by a
  // TradingView-style axis drag (changes `span` = vertical zoom) or by
  // dragging the candle area vertically (changes only `center` = a
  // pure price translation, span untouched). `base` is the auto-fit
  // span at the moment the manual range started, kept only as a sane
  // clamp range; null scale = auto-fit.
  const scaleRef = useRef<{ center: number; span: number; base: number } | null>(null);
  const autoRangeRef = useRef<{ lo: number; hi: number } | null>(null);
  const scaleDragRef = useRef<{ lastY: number } | null>(null);
  const [scaled, setScaled] = useState(false);
  const scaledRef = useRef(false);
  // Date & price range measurement ("Rentang tanggal dan harga").
  // Points are anchored to bar index + price (not pixels) so the box
  // stays on its candles while the view pans/zooms or data refetches.
  type MeasurePoint = { idx: number; price: number };
  const measureRef = useRef<{ start: MeasurePoint; end: MeasurePoint } | null>(null);
  const measureDragRef = useRef(false);
  const measureModeRef = useRef(false);
  const [measureMode, setMeasureModeState] = useState(false);
  const [hasMeasure, setHasMeasure] = useState(false);
  const setMeasureMode = (on: boolean) => {
    measureModeRef.current = on;
    setMeasureModeState(on);
  };
  const clearMeasure = () => {
    measureRef.current = null;
    measureDragRef.current = false;
    setHasMeasure(false);
    drawRef.current?.();
  };

  const syncPanned = () => {
    const p = viewRef.current.offset !== 0;
    if (p !== pannedRef.current) {
      pannedRef.current = p;
      setPanned(p);
    }
  };
  const maxOffset = () => {
    const n = dataRef.current.candles.length;
    return Math.max(0, n - Math.min(viewRef.current.count, Math.max(1, n)));
  };
  // Panning right may overshoot the latest candle: up to count-1 empty
  // future bars, so the last candle can be dragged almost to the left
  // edge and the right side never feels "mentok" (stuck).
  const minOffset = () => {
    const n = dataRef.current.candles.length;
    const count = Math.min(viewRef.current.count, Math.max(1, n));
    return -(count - 1);
  };
  const panBy = (deltaBars: number) => {
    viewRef.current.offset = Math.max(minOffset(), Math.min(maxOffset(), viewRef.current.offset + deltaBars));
    syncPanned();
    drawRef.current?.();
  };
  const syncScaled = () => {
    const s = scaleRef.current !== null;
    if (s !== scaledRef.current) {
      scaledRef.current = s;
      setScaled(s);
    }
  };
  const resetScale = () => {
    scaleRef.current = null;
    syncScaled();
    drawRef.current?.();
  };
  const scaleBy = (factor: number) => {
    if (!scaleRef.current) {
      const auto = autoRangeRef.current;
      if (!auto) return;
      scaleRef.current = { center: (auto.lo + auto.hi) / 2, span: auto.hi - auto.lo, base: auto.hi - auto.lo };
    }
    const sc = scaleRef.current;
    sc.span = Math.min(sc.base * 100, Math.max(sc.base * 0.01, sc.span * factor));
    syncScaled();
    drawRef.current?.();
  };
  const resetView = () => {
    viewRef.current = { count: 90, offset: 0 };
    scaleRef.current = null;
    syncPanned();
    syncScaled();
    drawRef.current?.();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const { candles: cs, overlayPlots: overlays, panes: subPanes, liquidity: liq } = dataRef.current;
      const w = wrap.clientWidth;
      const h = height;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      if (cs.length === 0) {
        ctx.fillStyle = AXIS_TEXT;
        ctx.font = "12px system-ui";
        ctx.fillText("Memuat data…", 12, 24);
        return;
      }

      const view = viewRef.current;
      const plotW = Math.max(50, w - AXIS_W);
      const n = cs.length;
      const count = Math.max(10, Math.min(view.count, n));
      // Keep the panned window valid as live candles slide underneath
      // it. The lower bound is negative: the window may extend past the
      // latest candle into empty future bars.
      view.offset = Math.max(-(count - 1), Math.min(view.offset, Math.max(0, n - count)));
      // Scrolled all the way to the oldest loaded candle: ask the
      // parent to page in older history (auto-load on left edge).
      if (view.offset >= Math.max(0, n - count)) needMoreRef.current?.();
      const end = Math.max(count, n - view.offset); // exclusive index
      const start = end - count;
      const barW = plotW / count;
      const x = (i: number) => (i - start + 0.5) * barW;

      // Pane layout: sub-panes share the bottom, main pane takes the rest.
      const subH = subPanes.length ? Math.max(56, Math.min(110, h * 0.22)) : 0;
      const timeAxisH = 18;
      const mainH = h - timeAxisH - subH * subPanes.length;
      const paneTops: number[] = [];
      for (let p = 0; p < subPanes.length; p++) paneTops.push(mainH + p * subH);

      const drawPaneScale = (
        top: number,
        ph: number,
        min: number,
        max: number,
        label?: string,
        padFrac = 0.08,
      ) => {
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) { min = 0; max = 1; }
        const pad = (max - min) * padFrac;
        min -= pad; max += pad;
        const y = (v: number) => top + ph - ((v - min) / (max - min)) * ph;
        ctx.strokeStyle = GRID;
        ctx.fillStyle = AXIS_TEXT;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.lineWidth = 0.5;
        for (let g = 0; g <= 4; g++) {
          const gy = top + (ph / 4) * g;
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(plotW, gy); ctx.stroke();
          const val = max - ((max - min) / 4) * g;
          ctx.fillText(fmtAxis(val), plotW + 5, gy + 3);
        }
        if (label) {
          ctx.fillStyle = "rgba(17,24,39,0.55)";
          ctx.font = "10px system-ui";
          ctx.fillText(label, 6, top + 13);
        }
        return y;
      };

      const rangeOf = (plots: PlotOutput[], extra?: { min: number; max: number }) => {
        let min = extra?.min ?? Infinity;
        let max = extra?.max ?? -Infinity;
        for (const p of plots) {
          if (p.kind === "bgcolor") continue;
          for (let i = start; i < end; i++) {
            const v = p.values[i];
            if (typeof v === "number" && Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
            const fb = p.fillBottom?.[i];
            if (typeof fb === "number" && Number.isFinite(fb)) { min = Math.min(min, fb); max = Math.max(max, fb); }
          }
        }
        return { min, max };
      };

      // ---- main pane range (candles + overlays)
      let pMin = Infinity; let pMax = -Infinity;
      let vMax = 0;
      for (let i = start; i < end; i++) {
        const c = cs[i];
        if (!c) continue;
        pMin = Math.min(pMin, c.low);
        pMax = Math.max(pMax, c.high);
        vMax = Math.max(vMax, c.volume);
      }
      const oRange = rangeOf(overlays);
      if (Number.isFinite(oRange.min)) { pMin = Math.min(pMin, oRange.min); pMax = Math.max(pMax, oRange.max); }
      // The Liquidity Master ladder spans its full price range; like
      // the original's boxes, it stretches the price scale to fit.
      if (liq && liq.ready) {
        pMin = Math.min(pMin, liq.base);
        pMax = Math.max(pMax, liq.base + liq.nrow * liq.step);
      }
      // Remember the padded auto-fit range: an axis drag starts manual
      // scaling from exactly the range currently on screen.
      if (Number.isFinite(pMin) && Number.isFinite(pMax) && pMax > pMin) {
        const autoPad = (pMax - pMin) * 0.08;
        autoRangeRef.current = { lo: pMin - autoPad, hi: pMax + autoPad };
      }
      let effMin = pMin;
      let effMax = pMax;
      let padFrac = 0.08;
      const manualScale = scaleRef.current;
      if (manualScale) {
        effMin = manualScale.center - manualScale.span / 2;
        effMax = manualScale.center + manualScale.span / 2;
        padFrac = 0;
      }
      const yMain = drawPaneScale(0, mainH, effMin, effMax, undefined, padFrac);

      // ---- bgcolor overlays
      for (const p of overlays) {
        if (p.kind !== "bgcolor") continue;
        for (let i = start; i < end; i++) {
          const colr = p.colors ? p.colors[i] : p.values[i] != null ? p.color : null;
          if (!colr) continue;
          ctx.fillStyle = colr;
          ctx.fillRect((i - start) * barW, 0, Math.ceil(barW), mainH);
        }
      }

      // ---- volume (bottom 14% of main pane)
      const volTop = mainH * 0.86;
      for (let i = start; i < end; i++) {
        const c = cs[i];
        if (!c || vMax === 0) continue;
        const vh = (c.volume / vMax) * (mainH - volTop);
        ctx.fillStyle = c.close >= c.open ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
        const bw = Math.max(1, barW * 0.7);
        ctx.fillRect(x(i) - bw / 2, mainH - vh, bw, vh);
      }

      // ---- candles
      const bw = Math.max(1, barW * 0.65);
      for (let i = start; i < end; i++) {
        const c = cs[i];
        if (!c) continue;
        const up = c.close >= c.open;
        ctx.strokeStyle = up ? UP : DOWN;
        ctx.fillStyle = up ? UP : DOWN;
        ctx.beginPath();
        ctx.moveTo(x(i), yMain(c.high));
        ctx.lineTo(x(i), yMain(c.low));
        ctx.stroke();
        const yo = yMain(c.open); const yc = yMain(c.close);
        const topBody = Math.min(yo, yc);
        const hBody = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(x(i) - bw / 2, topBody, bw, hBody);
      }

      // ---- plot drawing helper
      const drawPlot = (p: PlotOutput, y: (v: number) => number, top: number, ph: number) => {
        const colorAt = (i: number): string => (p.colors ? (p.colors[i] ?? p.color) : p.color);
        if (p.kind === "bgcolor") return;
        if (p.kind === "hline") {
          const v = p.values.find((vv) => typeof vv === "number");
          if (typeof v !== "number") return;
          ctx.strokeStyle = p.color;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(plotW, y(v)); ctx.stroke();
          ctx.setLineDash([]);
          return;
        }
        if (p.kind === "columns" || p.kind === "histogram") {
          const zero = y(0);
          const bw2 = Math.max(1, barW * 0.6);
          for (let i = start; i < end; i++) {
            const v = p.values[i];
            if (typeof v !== "number") continue;
            ctx.fillStyle = colorAt(i);
            const yv = y(v);
            ctx.fillRect(x(i) - bw2 / 2, Math.min(yv, zero), bw2, Math.max(1, Math.abs(zero - yv)));
          }
          return;
        }
        if (p.kind === "fill") {
          // Gradient band between the top edge (values) and the bottom
          // edge (fillBottom), colored per bar from top to bottom edge.
          const bottomVals = p.fillBottom;
          if (!bottomVals) return;
          for (let i = start; i < end - 1; i++) {
            const t0 = p.values[i]; const t1 = p.values[i + 1];
            const b0 = bottomVals[i]; const b1 = bottomVals[i + 1];
            if (typeof t0 !== "number" || typeof t1 !== "number" || typeof b0 !== "number" || typeof b1 !== "number") continue;
            const topC = (p.colors ? p.colors[i] : null) ?? p.color;
            const botC = (p.fillBottomColors ? p.fillBottomColors[i] : null) ?? topC;
            const yTop = Math.min(y(t0), y(t1));
            const yBot = Math.max(y(b0), y(b1));
            const grad = ctx.createLinearGradient(0, yTop, 0, Math.max(yBot, yTop + 1));
            grad.addColorStop(0, topC);
            grad.addColorStop(1, botC);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(x(i) - barW / 2, y(t0));
            ctx.lineTo(x(i + 1) + barW / 2, y(t1));
            ctx.lineTo(x(i + 1) + barW / 2, y(b1));
            ctx.lineTo(x(i) - barW / 2, y(b0));
            ctx.closePath();
            ctx.fill();
          }
          return;
        }
        if (p.kind === "shapes") {
          for (let i = start; i < end; i++) {
            const v = p.values[i];
            const c = cs[i];
            if (typeof v !== "number" || !c) continue;
            ctx.fillStyle = colorAt(i);
            const cx = x(i);
            const cy = yMain(c.low) + 10;
            ctx.beginPath();
            ctx.moveTo(cx, cy - 4); ctx.lineTo(cx - 4, cy + 3); ctx.lineTo(cx + 4, cy + 3);
            ctx.closePath(); ctx.fill();
          }
          return;
        }
        if (p.kind === "circles" || p.kind === "cross") {
          ctx.fillStyle = p.color;
          for (let i = start; i < end; i++) {
            const v = p.values[i];
            if (typeof v !== "number") continue;
            ctx.beginPath();
            ctx.arc(x(i), y(v), 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          return;
        }
        // line / area
        ctx.lineWidth = Math.max(1, p.lineWidth);
        if (p.colors) {
          // Per-bar colors: stroke segment by segment so the line can
          // change color with the series (e.g. trend direction).
          let px = 0; let py = 0; let hasPrev = false;
          for (let i = start; i < end; i++) {
            const v = p.values[i];
            if (typeof v !== "number") { hasPrev = false; continue; }
            const xi = x(i); const yi = y(v);
            if (hasPrev) {
              ctx.strokeStyle = colorAt(i);
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(xi, yi);
              ctx.stroke();
            }
            px = xi; py = yi; hasPrev = true;
          }
          ctx.lineWidth = 1;
          return;
        }
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        let started = false;
        let lastX = 0;
        for (let i = start; i < end; i++) {
          const v = p.values[i];
          if (typeof v !== "number") { started = false; continue; }
          const xi = x(i); const yi = y(v);
          if (!started) { ctx.moveTo(xi, yi); started = true; }
          else ctx.lineTo(xi, yi);
          lastX = xi;
        }
        ctx.stroke();
        if (p.kind === "area") {
          ctx.lineTo(lastX, top + ph);
          ctx.lineTo((0 - start + 0.5) * barW, top + ph);
          ctx.closePath();
          ctx.globalAlpha = 0.15;
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.lineWidth = 1;
      };

      // Fills (clouds) first so lines and candles stay readable on top.
      for (const p of overlays) if (p.kind === "fill") drawPlot(p, yMain, 0, mainH);
      for (const p of overlays) if (p.kind !== "fill") drawPlot(p, yMain, 0, mainH);

      // ---- Liquidity Master: depth ladder over the last bars, wall
      // lines with halos, and wall name labels — drawn like the
      // original script's boxes/lines/labels (ladder width 30 bars,
      // rows inset 7% of the row height, glow past t > 0.5, wall lines
      // reaching 150 bars back).
      if (liq && liq.ready && liq.hasLiquidity) {
        const xR = x(n - 1);
        const ladderW = Math.min(30 * barW, plotW * 0.5);
        const brightMul = 0.4 + 0.2 * 3; // Brightness input default 3
        for (const row of liq.rows) {
          if (row.t < 0.03) continue;
          const col = row.above ? COL_ASK : COL_BID;
          const wd = Math.max(1, ladderW * row.t);
          if (row.t > 0.5) {
            ctx.fillStyle = hexA(col, (14 * row.t * brightMul) / 100);
            ctx.fillRect(
              xR - wd - 1,
              yMain(row.y1 + liq.step * 0.2),
              wd + 1,
              Math.max(1, yMain(row.y0 - liq.step * 0.2) - yMain(row.y1 + liq.step * 0.2)),
            );
          }
          const transp = Math.round(82 - 65 * Math.pow(row.t, 1.2) * brightMul);
          const alpha = 1 - Math.min(Math.max(transp, 32), 90) / 100;
          ctx.fillStyle = hexA(col, alpha);
          const yTop = yMain(row.y1 - liq.step * 0.07);
          const yBot = yMain(row.y0 + liq.step * 0.07);
          ctx.fillRect(xR - wd, yTop, wd, Math.max(1, yBot - yTop));
        }
        // Ladder edge line.
        ctx.strokeStyle = "rgba(42,46,57,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xR + 1, yMain(liq.base + liq.nrow * liq.step));
        ctx.lineTo(xR + 1, yMain(liq.base));
        ctx.stroke();
        // Wall lines: soft halo (width 6 and 3, like the original's
        // transp-86/72 companion lines) under a dotted main line.
        const drawWall = (price: number, col: string, name: string) => {
          const y = yMain(price);
          if (y < -10 || y > mainH + 10) return;
          const x1 = x(Math.max(start, n - 1 - 150));
          ctx.strokeStyle = hexA(col, 0.14);
          ctx.lineWidth = 6;
          ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xR, y); ctx.stroke();
          ctx.strokeStyle = hexA(col, 0.28);
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xR, y); ctx.stroke();
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xR, y); ctx.stroke();
          ctx.setLineDash([]);
          // Name label: pill (chart bg at 75%) with the wall name and
          // price, ending at the ladder's right edge like the original.
          const label = `${name} ${pxPrice(price)}`;
          ctx.font = "11px 'JetBrains Mono', monospace";
          const tw = ctx.measureText(label).width;
          const lx = Math.max(2, xR - tw - 10);
          ctx.fillStyle = "rgba(255,255,255,0.78)";
          ctx.fillRect(lx - 4, y - 8, tw + 8, 16);
          ctx.fillStyle = col;
          ctx.fillText(label, lx, y + 4);
        };
        if (liq.wallUp) drawWall(liq.wallUp.price, COL_ASK, "sell wall");
        if (liq.wallDn) drawWall(liq.wallDn.price, COL_BID, "buy wall");
      }

      // ---- sub panes
      subPanes.forEach((pane, pi) => {
        const top = paneTops[pi] ?? mainH;
        ctx.strokeStyle = "rgba(15,23,42,0.06)";
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w, top); ctx.stroke();
        ctx.lineWidth = 1;
        // bgcolor in sub-pane
        for (const p of pane.plots) {
          if (p.kind !== "bgcolor") continue;
          for (let i = start; i < end; i++) {
            const colr = p.colors ? p.colors[i] : p.values[i] != null ? p.color : null;
            if (!colr) continue;
            ctx.fillStyle = colr;
            ctx.fillRect((i - start) * barW, top, Math.ceil(barW), subH);
          }
        }
        const r = rangeOf(pane.plots);
        const y = drawPaneScale(top, subH, r.min, r.max, pane.name);
        for (const p of pane.plots) drawPlot(p, y, top, subH);
      });

      // ---- vertical grid + time axis
      const first = cs[start];
      const second = cs[Math.min(start + 1, n - 1)];
      const spanMs = first && second ? Math.abs(second.time - first.time) : 0;
      ctx.fillStyle = AXIS_TEXT;
      ctx.font = "10px 'JetBrains Mono', monospace";
      const stepBars = Math.max(1, Math.round(64 / barW));
      const lastCandle = cs[n - 1];
      for (let i = start; i < end; i += stepBars) {
        const c = cs[i];
        // Bars past the latest candle are empty future space: their
        // time is extrapolated from the candle spacing so the axis
        // keeps labeling while panned into the future.
        const t = c ? c.time : lastCandle && spanMs > 0 ? lastCandle.time + (i - (n - 1)) * spanMs : null;
        if (t == null) continue;
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(x(i), 0); ctx.lineTo(x(i), h - timeAxisH); ctx.stroke();
        ctx.lineWidth = 1;
        const d = new Date(t);
        const label = spanMs >= 86400000
          ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })
          : d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
        ctx.fillText(label, x(i) - 14, h - 5);
      }

      // ---- last price line + tag (whenever the last candle is visible,
      // including when the view is panned into the future space)
      const last = cs[n - 1];
      if (last && start <= n - 1 && n - 1 < end) {
        const y = yMain(last.close);
        if (y >= 0 && y <= mainH) {
          ctx.strokeStyle = last.close >= last.open ? UP : DOWN;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = last.close >= last.open ? UP : DOWN;
          ctx.fillRect(plotW + 1, y - 8, AXIS_W - 2, 16);
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 10px 'JetBrains Mono', monospace";
          ctx.fillText(fmtAxis(last.close), plotW + 5, y + 3);
        }
      }

      // ---- crosshair time chip: full date & time label centered
      // under the crosshair in the time-axis strip, TradingView-style.
      // Follows the cursor wherever it moves (real candles and the
      // empty future space alike).
      const drawTimeChip = (cxPos: number, t: number) => {
        const d = new Date(t);
        const datePart = d
          .toLocaleDateString("id-ID", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "2-digit",
          })
          .replace(/,/g, "");
        const label =
          spanMs >= 86400000
            ? datePart
            : `${datePart} ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        const tw = ctx.measureText(label).width;
        const chipW = tw + 14;
        const chipH = 16;
        const chipY = h - timeAxisH + (timeAxisH - chipH) / 2;
        // Keep the whole chip inside the plot area at both edges.
        const chipX = Math.max(0, Math.min(Math.max(0, plotW - chipW), cxPos - chipW / 2));
        ctx.fillStyle = "#111827";
        ctx.fillRect(chipX, chipY, chipW, chipH);
        ctx.fillStyle = "#ffffff";
        const prevAlign = ctx.textAlign;
        ctx.textAlign = "center";
        ctx.fillText(label, chipX + chipW / 2, chipY + chipH / 2 + 3.5);
        ctx.textAlign = prevAlign;
      };

      // ---- crosshair
      const hov = hoverRef.current;
      if (hov && hov.x < plotW) {
        const idx = Math.min(end - 1, Math.max(start, start + Math.floor(hov.x / barW)));
        const c = cs[idx];
        if (c) {
          ctx.strokeStyle = "rgba(17,24,39,0.28)";
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(x(idx), 0); ctx.lineTo(x(idx), h - timeAxisH); ctx.stroke();
          if (hov.y < mainH) {
            ctx.beginPath(); ctx.moveTo(0, hov.y); ctx.lineTo(plotW, hov.y); ctx.stroke();
            // Inverse of the main pane scale (auto-fit or manual).
            const pad = (effMax - effMin) * padFrac;
            const lo = effMin - pad; const hi = effMax + pad;
            const pv = hi - (hov.y / mainH) * (hi - lo);
            ctx.fillStyle = "#374151";
            ctx.fillRect(plotW + 1, hov.y - 8, AXIS_W - 2, 16);
            ctx.fillStyle = "#ffffff";
            ctx.font = "10px 'JetBrains Mono', monospace";
            ctx.fillText(fmtAxis(pv), plotW + 5, hov.y + 3);
          }
          ctx.setLineDash([]);
          const d = new Date(c.time);
          const when = spanMs >= 86400000
            ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
            : `${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
          const chg = ((c.close - c.open) / c.open) * 100;
          const info = `${when}  O ${fmtPrice(c.open)}  H ${fmtPrice(c.high)}  L ${fmtPrice(c.low)}  C ${fmtPrice(c.close)}  ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
          ctx.font = "10px 'JetBrains Mono', monospace";
          const tw = ctx.measureText(info).width + 12;
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillRect(4, 4, tw, 18);
          ctx.strokeStyle = "rgba(15,23,42,0.08)";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(4, 4, tw, 18);
          ctx.lineWidth = 1;
          ctx.fillStyle = c.close >= c.open ? UP : DOWN;
          ctx.fillText(info, 10, 17);
          drawTimeChip(x(idx), c.time);
        }
      }

      // ---- crosshair over the future blank space (no candle there yet)
      if (hov && hov.x < plotW && spanMs > 0) {
        const idx = Math.min(end - 1, Math.max(start, start + Math.floor(hov.x / barW)));
        const lastC = cs[n - 1];
        if (idx >= n && lastC) {
          ctx.strokeStyle = "rgba(17,24,39,0.28)";
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(x(idx), 0); ctx.lineTo(x(idx), h - timeAxisH); ctx.stroke();
          ctx.setLineDash([]);
          const d = new Date(lastC.time + (idx - (n - 1)) * spanMs);
          const when = spanMs >= 86400000
            ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
            : `${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
          ctx.font = "10px 'JetBrains Mono', monospace";
          const tw = ctx.measureText(when).width + 12;
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillRect(4, 4, tw, 18);
          ctx.strokeStyle = "rgba(15,23,42,0.08)";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(4, 4, tw, 18);
          ctx.lineWidth = 1;
          ctx.fillStyle = AXIS_TEXT;
          ctx.fillText(when, 10, 17);
          drawTimeChip(x(idx), d.getTime());
        }
      }

      // ---- date & price range measurement box
      const meas = measureRef.current;
      if (meas) {
        const timeOf = (idx: number): number | null => {
          const c = cs[idx];
          if (c) return c.time;
          const lastC = cs[n - 1];
          return lastC && spanMs > 0 ? lastC.time + (idx - (n - 1)) * spanMs : null;
        };
        const x1 = x(meas.start.idx);
        const x2 = x(meas.end.idx);
        const y1 = yMain(meas.start.price);
        const y2 = yMain(meas.end.price);
        const rx = Math.min(x1, x2);
        const rw = Math.max(1, Math.abs(x2 - x1));
        const ry = Math.max(0, Math.min(y1, y2));
        const rh = Math.max(1, Math.min(mainH, Math.max(y1, y2)) - ry);
        ctx.fillStyle = "rgba(41,98,255,0.10)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = "rgba(41,98,255,0.8)";
        ctx.lineWidth = 1;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.fillStyle = "rgba(41,98,255,0.9)";
        for (const [ax, ay] of [[x1, y1], [x2, y2]] as const) {
          ctx.beginPath();
          ctx.arc(ax, Math.max(0, Math.min(mainH, ay)), 3, 0, Math.PI * 2);
          ctx.fill();
        }
        const dPrice = meas.end.price - meas.start.price;
        const pct = meas.start.price !== 0 ? (dPrice / meas.start.price) * 100 : 0;
        const bars = Math.abs(meas.end.idx - meas.start.idx);
        const t1 = timeOf(meas.start.idx);
        const t2 = timeOf(meas.end.idx);
        const line1 = `${dPrice >= 0 ? "+" : "-"}${fmtPrice(Math.abs(dPrice))} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
        const line2 = t1 != null && t2 != null
          ? `${bars} bar · ${fmtDuration(Math.abs(t2 - t1))}`
          : `${bars} bar`;
        const fmtWhen = (t: number) => {
          const d = new Date(t);
          return spanMs >= 86400000
            ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
            : `${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`;
        };
        const lines = t1 != null && t2 != null ? [line1, line2, `${fmtWhen(t1)} → ${fmtWhen(t2)}`] : [line1, line2];
        ctx.font = "10px 'JetBrains Mono', monospace";
        const lw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
        const lh = lines.length * 13 + 8;
        const cx = Math.max(2, Math.min(plotW - lw - 2, (x1 + x2) / 2 - lw / 2));
        const cy = Math.max(2, Math.min(mainH - lh - 2, (y1 + y2) / 2 - lh / 2));
        ctx.fillStyle = "rgba(17,24,39,0.92)";
        ctx.fillRect(cx, cy, lw, lh);
        ctx.fillStyle = "#ffffff";
        lines.forEach((l, li) => ctx.fillText(l, cx + 7, cy + 15 + li * 13));
      }
    };

    drawRef.current = draw;
    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const v = viewRef.current;
      const factor = ev.deltaY > 0 ? 1.15 : 0.87;
      v.count = Math.max(15, Math.min(500, Math.round(v.count * factor)));
      draw();
    };

    // Pan / zoom via native pointer events. React synthetic pointer
    // handlers on the canvas proved unreliable in the embedded webview
    // (drags were swallowed), so the gesture layer is attached directly
    // to the canvas element instead.
    const pointers = pointersRef.current;
    // Convert a pointer position to a chart point (bar index + price)
    // for the measurement tool, using the same geometry as draw():
    // the main pane's padded auto-fit range, or the manual scale.
    const pointFromEvent = (ev: PointerEvent): { idx: number; price: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const { candles: cs, panes: subPanes } = dataRef.current;
      const n = cs.length;
      if (n === 0) return null;
      const plotW = Math.max(50, rect.width - AXIS_W);
      const count = Math.max(10, Math.min(viewRef.current.count, n));
      const end = Math.max(count, n - viewRef.current.offset);
      const start = end - count;
      const barW = plotW / count;
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const subCount = subPanes.length;
      const subH = subCount ? Math.max(56, Math.min(110, height * 0.22)) : 0;
      const mainH = Math.max(40, height - 18 - subH * subCount);
      if (px < 0 || px >= plotW || py < 0 || py > mainH) return null;
      const idx = Math.max(start, Math.min(end - 1, start + Math.round(px / barW - 0.5)));
      let lo: number;
      let hi: number;
      const sc = scaleRef.current;
      if (sc) {
        lo = sc.center - sc.span / 2;
        hi = sc.center + sc.span / 2;
      } else if (autoRangeRef.current) {
        lo = autoRangeRef.current.lo;
        hi = autoRangeRef.current.hi;
      } else {
        return null;
      }
      return { idx, price: hi - (py / mainH) * (hi - lo) };
    };
    const onPointerDown = (ev: PointerEvent) => {
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 1) {
        const rect = canvas.getBoundingClientRect();
        const plotW = Math.max(50, rect.width - AXIS_W);
        if (ev.clientX - rect.left >= plotW) {
          // Press started on the price axis: this gesture scales the
          // price range vertically instead of panning.
          const auto = autoRangeRef.current;
          if (auto && !scaleRef.current) {
            scaleRef.current = {
              center: (auto.lo + auto.hi) / 2,
              span: auto.hi - auto.lo,
              base: auto.hi - auto.lo,
            };
            syncScaled();
          }
          scaleDragRef.current = { lastY: ev.clientY };
          dragStartRef.current = null;
          pinchStartRef.current = null;
          canvas.style.cursor = "ns-resize";
          return;
        }
        if (measureModeRef.current) {
          // Measurement tool armed: this drag draws the range box
          // instead of panning.
          const pt = pointFromEvent(ev);
          if (pt) {
            measureRef.current = { start: pt, end: pt };
            measureDragRef.current = true;
            setHasMeasure(true);
            dragStartRef.current = null;
            pinchStartRef.current = null;
            canvas.style.cursor = "crosshair";
            draw();
            return;
          }
        }
        // Snapshot the effective price range so the vertical part of
        // this drag can translate it: the manual range when one is
        // active, else the padded auto-fit range currently on screen.
        const scNow = scaleRef.current;
        const autoNow = autoRangeRef.current;
        dragStartRef.current = {
          x: ev.clientX,
          y: ev.clientY,
          offset: viewRef.current.offset,
          center: scNow ? scNow.center : autoNow ? (autoNow.lo + autoNow.hi) / 2 : null,
          span: scNow ? scNow.span : autoNow ? autoNow.hi - autoNow.lo : 0,
        };
        pinchStartRef.current = null;
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) {
          pinchStartRef.current = {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            count: viewRef.current.count,
          };
        }
        dragStartRef.current = null;
        scaleDragRef.current = null;
        measureDragRef.current = false;
      }
    };
    const onPointerMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      hoverRef.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      if (pointers.has(ev.pointerId)) {
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      }
      const scaleDrag = scaleDragRef.current;
      const pinch = pinchStartRef.current;
      if (measureDragRef.current && measureRef.current && pointers.size === 1) {
        const pt = pointFromEvent(ev);
        if (pt) measureRef.current.end = pt;
      } else if (scaleDrag && pointers.size === 1 && scaleRef.current) {
        // Vertical axis drag: exponential rescale, anchored on the
        // price under the pointer so that price stays under the finger
        // while everything stretches (drag up) or flattens (drag down).
        const dy = ev.clientY - scaleDrag.lastY;
        scaleDrag.lastY = ev.clientY;
        if (dy !== 0) {
          const subCount = dataRef.current.panes.length;
          const subH = subCount ? Math.max(56, Math.min(110, height * 0.22)) : 0;
          const mainH = Math.max(40, height - 18 - subH * subCount);
          const y = Math.max(0, Math.min(mainH, ev.clientY - rect.top));
          const sc = scaleRef.current;
          const frac = 0.5 - y / mainH;
          const priceAtPointer = sc.center + frac * sc.span;
          const newSpan = Math.min(
            sc.base * 100,
            Math.max(sc.base * 0.01, sc.span * Math.exp(dy * 0.005)),
          );
          sc.center = priceAtPointer - frac * newSpan;
          sc.span = newSpan;
        }
      } else if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a && b) {
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > 0) {
            viewRef.current.count = Math.max(15, Math.min(500, Math.round(pinch.count * (pinch.dist / dist))));
          }
        }
      } else if (dragStartRef.current) {
        const ds = dragStartRef.current;
        const { candles: cs } = dataRef.current;
        const plotW = Math.max(50, rect.width - AXIS_W);
        const barW = plotW / Math.max(10, Math.min(viewRef.current.count, Math.max(1, cs.length)));
        const dx = ev.clientX - ds.x;
        const cnt = Math.min(viewRef.current.count, Math.max(1, cs.length));
        const maxOff = Math.max(0, cs.length - cnt);
        // Negative offset = panned past the latest candle into the
        // empty future space (TradingView-style, no right-edge stop).
        const minOff = -(cnt - 1);
        viewRef.current.offset = Math.max(minOff, Math.min(maxOff, ds.offset + Math.round(dx / barW)));
        syncPanned();
        // Vertical part of the same drag: translate the visible price
        // range so the candles ride with the pointer — dragging down
        // moves the candles down (range center rises by the dragged
        // price distance), dragging up moves them up. The span is NOT
        // touched: this is a shift, not the axis-drag zoom. The shift
        // is stored in scaleRef, so it persists across live refetches
        // until the view is reset ("Terbaru" / double-click / Home).
        const dy = ev.clientY - ds.y;
        // 3px dead zone: a horizontal pan with a pixel or two of
        // vertical drift must not pin the price range by accident.
        // The shift is computed from the total drag distance, so once
        // past the dead zone the translation starts smoothly.
        if (Math.abs(dy) >= 3 && ds.center != null && ds.span > 0) {
          if (!scaleRef.current) {
            // First vertical movement of an auto-fit chart: pin the
            // range currently on screen as the manual range (same
            // span, so nothing jumps), then translate it.
            scaleRef.current = { center: ds.center, span: ds.span, base: ds.span };
            syncScaled();
          }
          const subCount = dataRef.current.panes.length;
          const subH = subCount ? Math.max(56, Math.min(110, height * 0.22)) : 0;
          const mainH = Math.max(40, height - 18 - subH * subCount);
          const shift = (dy / mainH) * ds.span;
          // Generous clamp (±10 spans from the drag-start center) so
          // a wild fling can't lose the candles entirely; the reset
          // controls always bring them back regardless.
          const clamped = Math.max(-10 * ds.span, Math.min(10 * ds.span, shift));
          scaleRef.current.center = ds.center + clamped;
        }
      }
      draw();
    };
    const endPointer = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size === 0) {
        if (measureDragRef.current) {
          // Measurement finished: keep the box, disarm the tool so the
          // next drag pans again.
          measureDragRef.current = false;
          setMeasureMode(false);
        }
        dragStartRef.current = null;
        pinchStartRef.current = null;
        scaleDragRef.current = null;
        canvas.style.cursor = measureModeRef.current ? "crosshair" : "grab";
      } else if (pointers.size === 1) {
        pinchStartRef.current = null;
        scaleDragRef.current = null;
        const remaining = [...pointers.values()][0];
        if (remaining) {
          // Re-anchor the drag on the remaining pointer with a fresh
          // range snapshot, so a continued drag pans both directions
          // from where the pinch left off.
          const scNow = scaleRef.current;
          const autoNow = autoRangeRef.current;
          dragStartRef.current = {
            x: remaining.x,
            y: remaining.y,
            offset: viewRef.current.offset,
            center: scNow ? scNow.center : autoNow ? (autoNow.lo + autoNow.hi) / 2 : null,
            span: scNow ? scNow.span : autoNow ? autoNow.hi - autoNow.lo : 0,
          };
        }
      }
    };
    const onPointerLeave = () => {
      if (pointers.size === 0) {
        hoverRef.current = null;
        draw();
      }
    };
    const onDblClick = () => {
      viewRef.current = { count: 90, offset: 0 };
      scaleRef.current = null;
      syncPanned();
      syncScaled();
      draw();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDblClick);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDblClick);
    };
  }, [candles, overlayPlots, panes, height, liquidity]);

  const panBtn =
    "flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-white/90 text-base leading-none text-[var(--dim)] shadow-sm";

  return (
    <div ref={wrapRef} className="relative w-full touch-none select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        className={`block touch-none ${measureMode ? "cursor-crosshair" : "cursor-grab"}`}
        style={{ touchAction: "none" }}
        aria-label="Grafik candlestick — seret untuk menggeser kanan kiri (bisa melewati candle terbaru ke ruang kosong di kanan) dan ke atas bawah untuk menggeser rentang harga tanpa mengubah skala, seret sumbu harga di kanan ke atas atau bawah untuk mengubah skala harga vertikal, cubit atau roda mouse untuk zoom, klik dua kali untuk kembali ke terbaru"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); panBy(10); }
          else if (e.key === "ArrowRight") { e.preventDefault(); panBy(-10); }
          else if (e.key === "ArrowUp") { e.preventDefault(); scaleBy(0.85); }
          else if (e.key === "ArrowDown") { e.preventDefault(); scaleBy(1.18); }
          else if (e.key === "Home") { e.preventDefault(); resetView(); }
          else if (e.key === "Escape") {
            e.preventDefault();
            if (measureMode) setMeasureMode(false);
            else clearMeasure();
          }
        }}
      />
      <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Ukur rentang tanggal dan harga"
            aria-pressed={measureMode}
            onClick={() => {
              if (measureMode) setMeasureMode(false);
              else { clearMeasure(); setMeasureMode(true); }
            }}
            className={`h-8 rounded-md border px-2 font-mono text-[11px] font-semibold shadow-sm ${
              measureMode
                ? "border-[var(--accent)] bg-[var(--accent)] text-black"
                : "border-[var(--border)] bg-white/90 text-[var(--text)]"
            }`}
          >
            Ukur rentang
          </button>
          {hasMeasure && !measureMode && (
            <button
              type="button"
              aria-label="Hapus hasil pengukuran rentang"
              onClick={clearMeasure}
              className="h-8 rounded-md border border-[var(--border)] bg-white/90 px-2 font-mono text-[11px] font-semibold text-[var(--down)] shadow-sm"
            >
              ✕ Hapus
            </button>
          )}
        </div>
        {measureMode && (
          <span className="rounded-md bg-black/70 px-2 py-1 font-mono text-[10px] text-white">
            Seret di chart untuk mengukur
          </span>
        )}
      </div>
      <div className="absolute bottom-7 left-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="Lihat data lebih lama"
          onClick={() => panBy(20)}
          className={panBtn}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Lihat data lebih baru"
          onClick={() => panBy(-20)}
          className={panBtn}
        >
          ›
        </button>
        {(panned || scaled) && (
          <button
            type="button"
            aria-label="Kembali ke candle terbaru dan posisi harga awal"
            onClick={resetView}
            className="h-8 rounded-md border border-[var(--accent)] bg-white/90 px-2 font-mono text-[11px] font-semibold text-[var(--text)] shadow-sm"
          >
            ⤺ Terbaru
          </button>
        )}
        {scaled && (
          <button
            type="button"
            aria-label="Kembalikan skala harga ke otomatis"
            onClick={resetScale}
            className="h-8 rounded-md border border-[var(--accent)] bg-white/90 px-2 font-mono text-[11px] font-semibold text-[var(--text)] shadow-sm"
          >
            ⇕ Skala auto
          </button>
        )}
      </div>
    </div>
  );
}
