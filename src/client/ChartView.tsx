// Canvas candlestick renderer: candles + volume, overlay plots on the
// price pane, one sub-pane per non-overlay script, crosshair with OHLC
// readout, last-price line. Interaction: drag (mouse or touch) pans the
// candle window left/right, wheel/pinch zooms, the on-chart ‹ › buttons
// pan one step at a time, arrow keys pan, and double-click or the
// "Terbaru" button jumps back to the latest candle. Dragging vertically
// on the right-hand price axis rescales the price range TradingView-
// style (up stretches the candles taller, down flattens them); while a
// manual scale is active the main pane stops auto-fitting, and the
// "Skala auto" button, a double-click, or Home restores auto scale.
// Pointer handling is attached natively (not via React props) so a drag
// keeps tracking even while live refetches re-render the panel
// mid-gesture.

import { useEffect, useRef, useState } from "react";
import type { Candle, PlotOutput } from "./pine";

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

type View = { count: number; offset: number }; // offset = bars hidden past the right edge

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
}: {
  candles: Candle[];
  overlayPlots: PlotOutput[];
  panes: PaneGroup[];
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ count: 90, offset: 0 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dataRef = useRef({ candles, overlayPlots, panes });
  dataRef.current = { candles, overlayPlots, panes };
  const drawRef = useRef<(() => void) | null>(null);
  // Interaction state lives in refs (not effect-local variables) so an
  // in-progress drag survives the effect re-running on live refetches.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragStartRef = useRef<{ x: number; offset: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; count: number } | null>(null);
  const [panned, setPanned] = useState(false);
  const pannedRef = useRef(false);
  // Manual vertical price scale (TradingView axis drag). `base` is the
  // auto-fit span at the moment scaling started, kept only as a sane
  // clamp range; null scale = auto-fit.
  const scaleRef = useRef<{ center: number; span: number; base: number } | null>(null);
  const autoRangeRef = useRef<{ lo: number; hi: number } | null>(null);
  const scaleDragRef = useRef<{ lastY: number } | null>(null);
  const [scaled, setScaled] = useState(false);
  const scaledRef = useRef(false);

  const syncPanned = () => {
    const p = viewRef.current.offset > 0;
    if (p !== pannedRef.current) {
      pannedRef.current = p;
      setPanned(p);
    }
  };
  const maxOffset = () => {
    const n = dataRef.current.candles.length;
    return Math.max(0, n - Math.min(viewRef.current.count, Math.max(1, n)));
  };
  const panBy = (deltaBars: number) => {
    viewRef.current.offset = Math.max(0, Math.min(maxOffset(), viewRef.current.offset + deltaBars));
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
      const { candles: cs, overlayPlots: overlays, panes: subPanes } = dataRef.current;
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
      // Keep the panned window valid as live candles slide underneath it.
      view.offset = Math.max(0, Math.min(view.offset, Math.max(0, n - count)));
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
      for (let i = start; i < end; i += stepBars) {
        const c = cs[i];
        if (!c) continue;
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(x(i), 0); ctx.lineTo(x(i), h - timeAxisH); ctx.stroke();
        ctx.lineWidth = 1;
        const d = new Date(c.time);
        const label = spanMs >= 86400000
          ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })
          : d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
        ctx.fillText(label, x(i) - 14, h - 5);
      }

      // ---- last price line + tag
      const last = cs[n - 1];
      if (last && view.offset === 0) {
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
        }
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
        dragStartRef.current = { x: ev.clientX, offset: viewRef.current.offset };
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
      if (scaleDrag && pointers.size === 1 && scaleRef.current) {
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
        const { candles: cs } = dataRef.current;
        const plotW = Math.max(50, rect.width - AXIS_W);
        const barW = plotW / Math.max(10, Math.min(viewRef.current.count, Math.max(1, cs.length)));
        const dx = ev.clientX - dragStartRef.current.x;
        const maxOff = Math.max(0, cs.length - Math.min(viewRef.current.count, Math.max(1, cs.length)));
        viewRef.current.offset = Math.max(0, Math.min(maxOff, dragStartRef.current.offset + Math.round(dx / barW)));
        syncPanned();
      }
      draw();
    };
    const endPointer = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size === 0) {
        dragStartRef.current = null;
        pinchStartRef.current = null;
        scaleDragRef.current = null;
        canvas.style.cursor = "grab";
      } else if (pointers.size === 1) {
        pinchStartRef.current = null;
        scaleDragRef.current = null;
        const remaining = [...pointers.values()][0];
        if (remaining) {
          dragStartRef.current = { x: remaining.x, offset: viewRef.current.offset };
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
  }, [candles, overlayPlots, panes, height]);

  const panBtn =
    "flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-white/90 text-base leading-none text-[var(--dim)] shadow-sm";

  return (
    <div ref={wrapRef} className="relative w-full touch-none select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="block cursor-grab touch-none"
        style={{ touchAction: "none" }}
        aria-label="Grafik candlestick — seret untuk menggeser kanan kiri, seret sumbu harga di kanan ke atas atau bawah untuk mengubah skala harga vertikal, cubit atau roda mouse untuk zoom, klik dua kali untuk kembali ke terbaru"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); panBy(10); }
          else if (e.key === "ArrowRight") { e.preventDefault(); panBy(-10); }
          else if (e.key === "ArrowUp") { e.preventDefault(); scaleBy(0.85); }
          else if (e.key === "ArrowDown") { e.preventDefault(); scaleBy(1.18); }
          else if (e.key === "Home") { e.preventDefault(); resetView(); }
        }}
      />
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
        {panned && (
          <button
            type="button"
            aria-label="Kembali ke candle terbaru"
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
