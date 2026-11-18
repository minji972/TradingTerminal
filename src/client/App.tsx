import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { ChartView, fmtPrice, transformCandles, type ChartType, type PaneGroup } from "./ChartView";
import { runPineScript, type InputDef, type PlotOutput, type ScriptResult } from "./pine";
import { LIBRARY, BLANK_SCRIPT, MA_CLOUD } from "./library";

const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "TRXUSDT", "LINKUSDT", "AVAXUSDT",
] as const;
type SymbolName = (typeof SYMBOLS)[number];

const INTERVALS = [
  "1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h",
  "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M",
] as const;
type IntervalName = (typeof INTERVALS)[number];

type PanelScript = { id: string; label: string; code: string };
type PanelConfig = {
  id: string;
  symbol: SymbolName;
  interval: IntervalName;
  chartType: ChartType;
  scripts: PanelScript[];
  inputs: Record<string, Record<string, number | boolean | string>>;
};

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "candles", label: "Candle" },
  { value: "heikin", label: "Heikin Ashi" },
  { value: "renko", label: "Renko" },
];
type Layout = 1 | 2 | 4;

type Ticker = ApiResponse<typeof api, "getTickers">["tickers"][number];

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return `id-${Date.now().toString(36)}-${uidCounter}`;
}

function cloudScript(): PanelScript {
  return { id: uid(), label: MA_CLOUD.label, code: MA_CLOUD.code };
}

function defaultPanels(): PanelConfig[] {
  // The MA Cloud (LuxAlgo settings) is active by default on every panel,
  // as the user asked; it can be removed per panel like any other script.
  return [
    { id: uid(), symbol: "BTCUSDT", interval: "15m", chartType: "candles", scripts: [cloudScript()], inputs: {} },
    { id: uid(), symbol: "ETHUSDT", interval: "1h", chartType: "candles", scripts: [cloudScript()], inputs: {} },
    { id: uid(), symbol: "SOLUSDT", interval: "4h", chartType: "candles", scripts: [cloudScript()], inputs: {} },
    { id: uid(), symbol: "DOGEUSDT", interval: "5m", chartType: "candles", scripts: [cloudScript()], inputs: {} },
  ];
}

const STORAGE_KEY = "trading-terminal-2:v1";

type StoredState = { layout: Layout; panels: PanelConfig[]; activePanelId: string; cloudActivated?: boolean };

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredState;
      if (Array.isArray(parsed.panels) && parsed.panels.length === 4) {
        // One-time activation: add the MA Cloud to panels that don't have
        // it yet (existing users who saved a layout before the cloud
        // existed). The flag keeps it from coming back if removed later.
        // Panels saved before chart types existed get plain candles.
        const withCloud = parsed.cloudActivated
          ? parsed.panels
          : parsed.panels.map((p) =>
              p.scripts.some((s) => s.code === MA_CLOUD.code)
                ? p
                : { ...p, scripts: [...p.scripts, cloudScript()] },
            );
        const panels = withCloud.map((p) => ({
          ...p,
          chartType: (p.chartType === "heikin" || p.chartType === "renko" ? p.chartType : "candles") as ChartType,
        }));
        return {
          layout: parsed.layout === 1 || parsed.layout === 2 || parsed.layout === 4 ? parsed.layout : 4,
          panels,
          activePanelId: parsed.activePanelId ?? parsed.panels[0]?.id ?? "",
          cloudActivated: true,
        };
      }
    }
  } catch { /* fall through to defaults */ }
  const panels = defaultPanels();
  return { layout: 4, panels, activePanelId: panels[0]?.id ?? "", cloudActivated: true };
}

// ------------------------------------------------------------------ App

export function App() {
  const [state, setState] = useState<StoredState>(loadState);
  const [editorPanelId, setEditorPanelId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }, [state]);

  const tickers = useQuery({
    queryKey: ["tickers"],
    queryFn: () => api.getTickers({}),
    refetchInterval: 10000,
  });
  const tickerMap = useMemo(() => {
    const m = new Map<string, Ticker>();
    for (const t of tickers.data?.tickers ?? []) m.set(t.symbol, t);
    return m;
  }, [tickers.data]);

  const updatePanel = (id: string, patch: Partial<PanelConfig>) => {
    setState((s) => ({ ...s, panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  };

  const visiblePanels = maximizedId
    ? state.panels.filter((p) => p.id === maximizedId)
    : state.panels.slice(0, state.layout);

  const editorPanel = editorPanelId ? state.panels.find((p) => p.id === editorPanelId) ?? null : null;

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* Watchlist strip */}
      <div className="border-b border-[var(--border)] bg-[var(--surface)] pt-safe">
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="mr-1 flex shrink-0 items-center gap-1.5 pl-1">
            <span className={`inline-block h-2 w-2 rounded-full ${tickers.isError ? "bg-[var(--down)]" : "bg-[var(--up)] animate-pulse"}`} />
            <span className="font-mono text-[10px] tracking-widest text-[var(--dim)]">LIVE</span>
          </span>
          {(tickers.data?.tickers ?? []).map((t) => {
            const up = t.changePercent >= 0;
            return (
              <button
                key={t.symbol}
                type="button"
                aria-label={`Tampilkan ${t.symbol} di panel aktif`}
                onClick={() => updatePanel(state.activePanelId, { symbol: t.symbol as SymbolName })}
                className="shrink-0 rounded-md px-2 py-1 text-left hover:bg-[var(--surface2)]"
              >
                <span className="block font-mono text-[11px] font-semibold leading-tight">
                  {t.symbol.replace("USDT", "")}
                  <span className="text-[var(--dim)]">/USDT</span>
                </span>
                <span className="block font-mono text-[11px] leading-tight">
                  {fmtPrice(t.lastPrice)}{" "}
                  <span style={{ color: up ? "var(--up)" : "var(--down)" }}>
                    {up ? "▲" : "▼"} {Math.abs(t.changePercent).toFixed(2)}%
                  </span>
                </span>
              </button>
            );
          })}
          {tickers.isPending && <span className="px-2 font-mono text-[11px] text-[var(--dim)]">Memuat harga…</span>}
          {tickers.isError && <span className="px-2 font-mono text-[11px] text-[var(--down)]">Gagal memuat harga — cek koneksi</span>}
        </div>
      </div>

      {/* Layout toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-widest text-[var(--dim)]">LAYOUT</span>
        {([1, 2, 4] as Layout[]).map((l) => (
          <button
            key={l}
            type="button"
            aria-label={`Tata letak ${l} panel`}
            aria-pressed={state.layout === l && !maximizedId}
            onClick={() => { setState((s) => ({ ...s, layout: l })); setMaximizedId(null); }}
            className={`flex h-8 w-9 items-center justify-center rounded-md border font-mono text-xs ${
              state.layout === l && !maximizedId
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--dim)]"
            }`}
          >
            {l === 1 ? "▢" : l === 2 ? "◫" : "⊞"} {l}
          </button>
        ))}
        <span className="ml-auto hidden font-mono text-[10px] text-[var(--dim)] sm:block">
          Binance Spot · USDT
        </span>
      </div>

      {/* Panel grid */}
      <div
        className={`grid min-h-0 flex-1 gap-px bg-[var(--border)] ${
          maximizedId
            ? "grid-cols-1 grid-rows-1"
            : state.layout === 1
              ? "grid-cols-1 grid-rows-1"
              : state.layout === 2
                ? "grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1"
                : "grid-cols-1 grid-rows-4 sm:grid-cols-2 sm:grid-rows-2"
        }`}
      >
        {visiblePanels.map((panel) => (
          <Panel
            key={panel.id}
            panel={panel}
            ticker={tickerMap.get(panel.symbol)}
            isActive={state.activePanelId === panel.id}
            isMaximized={maximizedId === panel.id}
            showMaximize={state.layout > 1}
            onActivate={() => setState((s) => ({ ...s, activePanelId: panel.id }))}
            onChange={(patch) => updatePanel(panel.id, patch)}
            onOpenEditor={() => setEditorPanelId(panel.id)}
            onToggleMaximize={() => setMaximizedId((m) => (m === panel.id ? null : panel.id))}
          />
        ))}
      </div>

      {editorPanel && (
        <ScriptEditor
          panel={editorPanel}
          onClose={() => setEditorPanelId(null)}
          onChange={(patch) => updatePanel(editorPanel.id, patch)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Panel

function Panel({
  panel,
  ticker,
  isActive,
  isMaximized,
  showMaximize,
  onActivate,
  onChange,
  onOpenEditor,
  onToggleMaximize,
}: {
  panel: PanelConfig;
  ticker: Ticker | undefined;
  isActive: boolean;
  isMaximized: boolean;
  showMaximize: boolean;
  onActivate: () => void;
  onChange: (patch: Partial<PanelConfig>) => void;
  onOpenEditor: () => void;
  onToggleMaximize: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyH, setBodyH] = useState(220);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
    ro.observe(el);
    setBodyH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const klines = useQuery({
    queryKey: ["klines", panel.symbol, panel.interval],
    queryFn: () => api.getKlines({ symbol: panel.symbol, interval: panel.interval, limit: 500 }),
    refetchInterval: 3000,
  });
  const candles = useMemo(() => klines.data?.candles ?? [], [klines.data]);
  // Heikin Ashi / Renko transform the series the chart AND the Pine
  // scripts see (same as TradingView); the header price stays the real
  // last close from the raw candles.
  const displayCandles = useMemo(
    () => transformCandles(candles, panel.chartType),
    [candles, panel.chartType],
  );

  const results: { script: PanelScript; result: ScriptResult }[] = useMemo(() => {
    if (displayCandles.length === 0) return [];
    return panel.scripts.map((script) => ({
      script,
      result: runPineScript(script.code, displayCandles, panel.inputs[script.id] ?? {}),
    }));
  }, [panel.scripts, panel.inputs, displayCandles]);

  const overlayPlots: PlotOutput[] = [];
  const panes: PaneGroup[] = [];
  for (const { result } of results) {
    if (result.error) continue;
    if (result.overlay) overlayPlots.push(...result.plots);
    else if (result.plots.length > 0) panes.push({ name: result.name, plots: result.plots });
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  // Direction arrow matches the watchlist strip: 24h change when the
  // ticker is available, last-candle direction otherwise.
  const lastUp = ticker ? ticker.changePercent >= 0 : last && prev ? last.close >= prev.close : true;
  const errors = results.filter((r) => r.result.error);

  return (
    <section
      aria-label={`Panel ${panel.symbol} ${panel.interval}`}
      onPointerDown={onActivate}
      className={`flex min-h-0 flex-col bg-[var(--bg)] ${isActive ? "shadow-[inset_0_0_0_1px_var(--accent)]" : ""}`}
    >
      {/* Panel header */}
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <label className="sr-only" htmlFor={`sym-${panel.id}`}>Koin panel</label>
        <select
          id={`sym-${panel.id}`}
          aria-label="Koin panel"
          value={panel.symbol}
          onChange={(e) => onChange({ symbol: e.target.value as SymbolName })}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 font-mono text-xs font-semibold"
        >
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>{s.replace("USDT", "")}/USDT</option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`ct-${panel.id}`}>Jenis chart panel</label>
        <select
          id={`ct-${panel.id}`}
          aria-label="Jenis chart panel"
          value={panel.chartType}
          onChange={(e) => onChange({ chartType: e.target.value as ChartType })}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 font-mono text-xs"
        >
          {CHART_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-mono text-xs font-semibold">
            {last ? fmtPrice(last.close) : ticker ? fmtPrice(ticker.lastPrice) : "…"}
            {last && (
              <span className="ml-1.5 text-[10px]" style={{ color: lastUp ? "var(--up)" : "var(--down)" }}>
                {lastUp ? "▲" : "▼"}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-[var(--dim)]">
            {panel.interval}
            {panel.chartType === "heikin" ? " · Heikin Ashi" : panel.chartType === "renko" ? " · Renko" : ""}
            {" "}· {panel.scripts.length} indikator
          </div>
        </div>
        <button
          type="button"
          aria-label={`Kelola indikator Pine Script panel ${panel.symbol}`}
          onClick={onOpenEditor}
          className="h-8 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-xs text-[var(--accent)]"
        >
          ƒx Indikator{panel.scripts.length > 0 ? ` (${panel.scripts.length})` : ""}
        </button>
        {showMaximize && (
          <button
            type="button"
            aria-label={isMaximized ? `Kembalikan panel ${panel.symbol} ke grid` : `Perbesar panel ${panel.symbol}`}
            onClick={onToggleMaximize}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--dim)]"
          >
            {isMaximized ? "⤡" : "⤢"}
          </button>
        )}
      </div>

      {/* Timeframe chips */}
      <div className="flex gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Timeframe">
        {INTERVALS.map((tf) => (
          <button
            key={tf}
            type="button"
            aria-label={`Timeframe ${tf}`}
            aria-pressed={panel.interval === tf}
            onClick={() => onChange({ interval: tf })}
            className={`h-6 shrink-0 rounded px-2 font-mono text-[11px] ${
              panel.interval === tf
                ? "bg-[var(--accent)] font-bold text-black"
                : "bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* Legend */}
      {results.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1">
          {results.map(({ script, result }) => (
            <span key={script.id} className="font-mono text-[10px]">
              {result.error ? (
                <span className="text-[var(--down)]">⚠ {result.name}: error</span>
              ) : (
                <>
                  <span className="text-[var(--dim)]">{result.name}:</span>{" "}
                  {result.plots
                    .filter((p) => p.kind !== "bgcolor" && p.kind !== "shapes" && p.kind !== "fill")
                    .map((p) => {
                      const v = [...p.values].reverse().find((x) => typeof x === "number");
                      return (
                        <span key={p.title} style={{ color: p.color }}>
                          {p.title} {typeof v === "number" ? fmtPrice(v) : "—"}{"  "}
                        </span>
                      );
                    })}
                </>
              )}
            </span>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="mx-2 mb-1 rounded-md border border-[var(--down)] bg-[rgba(239,83,80,0.08)] px-2 py-1 font-mono text-[10px] text-[var(--down)]">
          {errors[0]?.result.error} — buka ƒx Indikator untuk memperbaiki script.
        </div>
      )}

      {/* Chart body */}
      <div ref={bodyRef} className="relative min-h-0 flex-1">
        {klines.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-[var(--dim)]">Gagal memuat candle {panel.symbol}.</p>
            <button
              type="button"
              onClick={() => void klines.refetch()}
              className="h-9 rounded-md border border-[var(--border)] px-3 text-sm"
            >
              Coba lagi
            </button>
          </div>
        ) : (
          <ChartView key={`${panel.symbol}:${panel.interval}:${panel.chartType}`} candles={displayCandles} overlayPlots={overlayPlots} panes={panes} height={Math.max(120, bodyH)} />
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Editor

function ScriptEditor({
  panel,
  onClose,
  onChange,
}: {
  panel: PanelConfig;
  onClose: () => void;
  onChange: (patch: Partial<PanelConfig>) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftLabel, setDraftLabel] = useState("");

  const klines = useQuery({
    queryKey: ["klines", panel.symbol, panel.interval],
    queryFn: () => api.getKlines({ symbol: panel.symbol, interval: panel.interval, limit: 500 }),
  });
  const candles = useMemo(() => klines.data?.candles ?? [], [klines.data]);

  const editingScript = panel.scripts.find((s) => s.id === editingId) ?? null;
  const draftResult = useMemo(() => {
    if (!editingScript || candles.length === 0) return null;
    return runPineScript(draft, candles, panel.inputs[editingScript.id] ?? {});
  }, [editingScript, draft, candles, panel.inputs]);

  const startEdit = (script: PanelScript) => {
    setEditingId(script.id);
    setDraft(script.code);
    setDraftLabel(script.label);
  };

  const addScript = (label: string, code: string) => {
    const script: PanelScript = { id: uid(), label, code };
    onChange({ scripts: [...panel.scripts, script] });
    startEdit(script);
  };

  const saveDraft = () => {
    if (!editingScript) return;
    onChange({
      scripts: panel.scripts.map((s) =>
        s.id === editingScript.id ? { ...s, code: draft, label: draftLabel || s.label } : s,
      ),
    });
    setEditingId(null);
  };

  const removeScript = (id: string) => {
    onChange({ scripts: panel.scripts.filter((s) => s.id !== id) });
    if (editingId === id) setEditingId(null);
  };

  const setInput = (scriptId: string, key: string, value: number | boolean | string) => {
    onChange({
      inputs: {
        ...panel.inputs,
        [scriptId]: { ...(panel.inputs[scriptId] ?? {}), [key]: value },
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)]" role="dialog" aria-label="Editor indikator Pine Script">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 pt-safe">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Indikator Pine Script</h2>
          <p className="truncate font-mono text-[11px] text-[var(--dim)]">
            {panel.symbol} · {panel.interval} — khusus panel ini
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup editor indikator"
          className="h-9 rounded-md border border-[var(--border)] px-3 text-sm"
        >
          Selesai
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {editingScript ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--dim)]" htmlFor="script-label">Nama script</label>
            <input
              id="script-label"
              aria-label="Nama script"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              className="mb-3 h-9 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            />
            <label className="mb-1 block text-xs font-medium text-[var(--dim)]" htmlFor="script-code">Kode Pine Script</label>
            <textarea
              id="script-code"
              aria-label="Kode Pine Script"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-64 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs leading-relaxed"
            />
            {draftResult?.error ? (
              <p className="mt-2 rounded-md border border-[var(--down)] bg-[rgba(239,83,80,0.08)] px-2 py-1.5 font-mono text-[11px] text-[var(--down)]">
                {draftResult.error}
              </p>
            ) : draftResult ? (
              <p className="mt-2 font-mono text-[11px] text-[var(--up)]">
                ✓ Script valid — {draftResult.plots.length} plot, {draftResult.overlay ? "overlay di harga" : "panel terpisah"}.
              </p>
            ) : (
              <p className="mt-2 font-mono text-[11px] text-[var(--dim)]">Memuat candle untuk validasi…</p>
            )}

            {draftResult && draftResult.inputs.length > 0 && (
              <div className="mt-3">
                <h3 className="mb-1 text-xs font-semibold">Parameter input</h3>
                <p className="mb-2 text-[11px] text-[var(--dim)]">Nilai input langsung diterapkan ke chart.</p>
                {draftResult.inputs.map((inp) => (
                  <InputControl
                    key={inp.key}
                    def={inp}
                    value={(panel.inputs[editingScript.id] ?? {})[inp.key]}
                    onChange={(v) => setInput(editingScript.id, inp.key, v)}
                  />
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={saveDraft}
                className="h-10 flex-1 rounded-md bg-[var(--accent)] font-semibold text-black"
              >
                Terapkan ke chart
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="h-10 rounded-md border border-[var(--border)] px-4"
              >
                Batal
              </button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
              Subset Pine v4/v5 yang didukung: ta.sma/ema/rma/wma/vwma/hma/rsi/macd/stoch/atr/tr/
              highest/lowest/change/mom/roc/stdev/cum/sum/crossover/crossunder/barssince/valuewhen/
              alma/bb/supertrend, math.*, input.*, plot/plotshape/hline/bgcolor/fill, fungsi buatan
              sendiri, if/else, for, dan referensi sejarah seperti close[1]. strategy() dan
              request.security() tidak didukung.
            </p>
          </div>
        ) : (
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--dim)]">SCRIPT DI PANEL INI ({panel.scripts.length})</h3>
            {panel.scripts.length === 0 && (
              <p className="mb-3 rounded-md border border-dashed border-[var(--border)] px-3 py-3 text-sm text-[var(--dim)]">
                Belum ada indikator di panel ini — chart bersih tanpa indikator, persis seperti
                yang diminta. Tambahkan script Pine di bawah, bisa sebanyak yang kamu mau.
              </p>
            )}
            <ul className="mb-5 space-y-2">
              {panel.scripts.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                  <button
                    type="button"
                    aria-label={`Edit script ${s.label}`}
                    onClick={() => startEdit(s)}
                    className="h-8 rounded-md border border-[var(--border)] px-2.5 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Hapus script ${s.label}`}
                    onClick={() => removeScript(s.id)}
                    className="h-8 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--down)]"
                  >
                    Hapus
                  </button>
                </li>
              ))}
            </ul>

            <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--dim)]">TAMBAH DARI CONTOH</h3>
            <ul className="mb-5 space-y-2">
              {LIBRARY.map((item) => (
                <li key={item.name} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="block truncate text-[11px] text-[var(--dim)]">{item.description}</span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Tambah script ${item.name}`}
                    onClick={() => addScript(item.name, item.code)}
                    className="h-8 shrink-0 rounded-md bg-[var(--accent)] px-3 text-xs font-bold text-black"
                  >
                    + Tambah
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => addScript("Script baru", BLANK_SCRIPT)}
              className="h-10 w-full rounded-md border border-[var(--accent)] font-mono text-sm text-[var(--accent)]"
            >
              + Tulis script kosong sendiri
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ inputs

function InputControl({
  def,
  value,
  onChange,
}: {
  def: InputDef;
  value: number | boolean | string | undefined;
  onChange: (v: number | boolean | string) => void;
}) {
  const current = value ?? def.defval;
  if (def.type === "bool") {
    return (
      <label className="mb-2 flex h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label={def.title}
          checked={current === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-5"
        />
        {def.title}
      </label>
    );
  }
  if (def.type === "source") {
    return (
      <label className="mb-2 flex items-center gap-2 text-sm">
        <span className="w-32 shrink-0 text-[var(--dim)]">{def.title}</span>
        <select
          aria-label={def.title}
          value={typeof current === "string" ? current : "close"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-sm"
        >
          {["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "volume"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === "string") {
    return (
      <label className="mb-2 flex items-center gap-2 text-sm">
        <span className="w-32 shrink-0 text-[var(--dim)]">{def.title}</span>
        <input
          aria-label={def.title}
          value={typeof current === "string" ? current : String(current)}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-sm"
        />
      </label>
    );
  }
  const numVal = typeof current === "number" ? current : Number(def.defval) || 0;
  return (
    <label className="mb-2 flex items-center gap-2 text-sm">
      <span className="w-32 shrink-0 text-[var(--dim)]">{def.title}</span>
      <input
        type="number"
        aria-label={def.title}
        value={numVal}
        min={def.min}
        max={def.max}
        step={def.step ?? (def.type === "int" ? 1 : 0.1)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(def.type === "int" ? Math.round(v) : v);
        }}
        className="h-9 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-sm"
      />
    </label>
  );
}
