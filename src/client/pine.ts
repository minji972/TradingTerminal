// A Pine Script (v4/v5 subset) interpreter that runs user scripts against
// OHLCV candles entirely on the client.
//
// Supported: indicator()/study() header, var/varip, :=, if/else blocks,
// for loops, user functions (=>, single-line and block), ternary, history
// references expr[n], destructuring [a,b] = ta.macd(...), input.* (with UI
// overrides), plot/plotshape/plotchar/hline/bgcolor/fill (gradient band
// between two plots), color.* constants and color.new/color.rgb, math.*,
// and the common ta.* library (sma, ema, rma, wma, vwma, hma, rsi, macd,
// stoch, atr, tr, highest, lowest, change, mom, roc, stdev, variance, cum,
// sum, crossover/crossunder/cross, barssince, valuewhen, alma, bb,
// supertrend; dmi is not included).
//
// Anything outside the subset raises a compile/runtime error that the
// editor surfaces with a line number — the chart never silently fakes it.

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PlotKind =
  | "line"
  | "area"
  | "columns"
  | "histogram"
  | "circles"
  | "cross"
  | "shapes"
  | "hline"
  | "bgcolor"
  | "fill";

export type PlotOutput = {
  title: string;
  kind: PlotKind;
  values: (number | null)[];
  /** Fixed color, or per-bar colors when colorIsSeries. */
  color: string;
  colors: (string | null)[] | null;
  lineWidth: number;
  overlay: boolean;
  /** kind === "fill" only: the band's bottom-edge values (values[] holds the top edge). */
  fillBottom?: (number | null)[] | null;
  /** kind === "fill" only: per-bar bottom-edge colors for the vertical gradient (colors[] holds the top-edge colors). */
  fillBottomColors?: (string | null)[] | null;
};

export type InputDef = {
  key: string;
  title: string;
  type: "int" | "float" | "bool" | "source" | "string";
  defval: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

export type ScriptResult = {
  name: string;
  overlay: boolean;
  plots: PlotOutput[];
  inputs: InputDef[];
  error: string | null;
};

// ---------------------------------------------------------------- values

type Scalar = number | boolean | string | null;
type Series = Scalar[]; // null = na
type Value = Scalar | Series | Value[]; // Value[] = tuple

const NA: null = null;

function isSeries(v: Value): v is Series {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] !== "object" || v[0] === null || typeof v[0] === "number" || typeof v[0] === "boolean" || typeof v[0] === "string") && !isTuple(v);
}
// Tuples are arrays whose elements may themselves be Series/Values; we mark
// them explicitly instead of guessing.
const TUPLE = Symbol("tuple");
type TupleValue = Value[] & { [TUPLE]?: true };
function isTuple(v: Value): v is TupleValue {
  return Array.isArray(v) && (v as TupleValue)[TUPLE] === true;
}
function makeTuple(items: Value[]): Value {
  const t = items as TupleValue;
  t[TUPLE] = true;
  return t;
}

// ---------------------------------------------------------------- lexer

type Tok = {
  kind: "num" | "str" | "ident" | "op" | "punct";
  text: string;
};

const OPS = [
  "==", "!=", ">=", "<=", ":=", "=>", "and", "or", "not",
  "+", "-", "*", "/", "%", ">", "<", "=", "?", ":", "(", ")", "[", "]", ",",
];

function tokenize(src: string, lineNo: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new PineError(`Baris ${lineNo}: ${msg}`);
  };
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "/" && src[i + 1] === "/") break; // comment
    if (ch === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= src.length) fail("String tidak ditutup");
      toks.push({ kind: "str", text: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      let dot = false;
      while (j < src.length && (/[0-9]/.test(src[j] ?? "") || (src[j] === "." && !dot))) {
        if (src[j] === ".") dot = true;
        j++;
      }
      toks.push({ kind: "num", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j] ?? "")) j++;
      let word = src.slice(i, j);
      while (word.endsWith(".")) word = word.slice(0, -1);
      if (word === "and" || word === "or" || word === "not") {
        toks.push({ kind: "op", text: word });
      } else {
        toks.push({ kind: "ident", text: word });
      }
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS.includes(two) && two.length === 2 && /[^+\-*/%><=?:(),\[\]]/.test(two) === false && (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === ":=" || two === "=>")) {
      toks.push({ kind: "op", text: two });
      i += 2;
      continue;
    }
    if ("+-*/%><=? :(),[]".replace(" ", "").includes(ch)) {
      toks.push({ kind: ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "," ? "punct" : "op", text: ch });
      i++;
      continue;
    }
    fail(`Karakter tidak dikenal: '${ch}'`);
  }
  return toks;
}

export class PineError extends Error {}

// ---------------------------------------------------------------- line tree

type LineNode = {
  indent: number;
  text: string;
  lineNo: number;
  children: LineNode[];
};

function buildLineTree(source: string): LineNode[] {
  const rawLines = source.split("\n");
  const logical: { indent: number; text: string; lineNo: number }[] = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx] ?? "";
    const text = raw.trim();
    if (!text || text.startsWith("//")) continue;
    const indent = raw.length - raw.replace(/^\s+/, "").length;
    // Join continuation lines: unbalanced parens/brackets, or the previous
    // logical line ends with an operator/comma.
    const prev = logical[logical.length - 1];
    const depth = prev ? bracketDepth(prev.text) : 0;
    const prevOpen = prev && (depth > 0 || /[+\-*/%<>=?:,]$/.test(prev.text.replace(/\/\/.*$/, "").trim()));
    if (prev && prevOpen && indent > 0) {
      prev.text += " " + text;
    } else {
      logical.push({ indent, text, lineNo: idx + 1 });
    }
  }
  const root: LineNode[] = [];
  const stack: { indent: number; children: LineNode[] }[] = [{ indent: -1, children: root }];
  for (const l of logical) {
    const node: LineNode = { ...l, children: [] };
    while (stack.length > 1 && l.indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop();
    stack[stack.length - 1]?.children.push(node);
    stack.push({ indent: l.indent, children: node.children });
  }
  return root;
}

function bracketDepth(text: string): number {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "/" && text[i + 1] === "/") break;
    if (c === "(" || c === "[") d++;
    if (c === ")" || c === "]") d--;
  }
  return d;
}

// ---------------------------------------------------------------- AST

let nextNodeId = 1;

type Expr =
  | { id: number; kind: "num"; value: number }
  | { id: number; kind: "str"; value: string }
  | { id: number; kind: "bool"; value: boolean }
  | { id: number; kind: "na" }
  | { id: number; kind: "ident"; name: string }
  | { id: number; kind: "unary"; op: string; arg: Expr }
  | { id: number; kind: "binary"; op: string; left: Expr; right: Expr }
  | { id: number; kind: "ternary"; cond: Expr; then: Expr; els: Expr }
  | { id: number; kind: "call"; name: string; args: { name: string | null; value: Expr }[] }
  | { id: number; kind: "hist"; target: Expr; offset: Expr };

function nid(): number { return nextNodeId++; }

class ExprParser {
  private pos = 0;
  constructor(private toks: Tok[], private lineNo: number) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos++];
    if (!t) throw new PineError(`Baris ${this.lineNo}: Ekspresi terpotong`);
    return t;
  }
  private fail(msg: string): never { throw new PineError(`Baris ${this.lineNo}: ${msg}`); }

  parseFull(): Expr {
    const e = this.parseTernary();
    if (this.pos < this.toks.length) {
      this.fail(`Token tak terduga: '${this.peek()?.text}'`);
    }
    return e;
  }

  parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.peek()?.text === "?") {
      this.next();
      const then = this.parseTernary();
      if (this.next().text !== ":") this.fail("Ternary butuh ':'");
      const els = this.parseTernary();
      return { id: nid(), kind: "ternary", cond, then, els };
    }
    return cond;
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.peek()?.text === "or") { this.next(); const r = this.parseAnd(); l = { id: nid(), kind: "binary", op: "or", left: l, right: r }; }
    return l;
  }
  private parseAnd(): Expr {
    let l = this.parseCmp();
    while (this.peek()?.text === "and") { this.next(); const r = this.parseCmp(); l = { id: nid(), kind: "binary", op: "and", left: l, right: r }; }
    return l;
  }
  private parseCmp(): Expr {
    let l = this.parseAdd();
    while (["==", "!=", ">", "<", ">=", "<="].includes(this.peek()?.text ?? "")) {
      const op = this.next().text;
      const r = this.parseAdd();
      l = { id: nid(), kind: "binary", op, left: l, right: r };
    }
    return l;
  }
  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.peek()?.text === "+" || this.peek()?.text === "-") {
      const op = this.next().text;
      const r = this.parseMul();
      l = { id: nid(), kind: "binary", op, left: l, right: r };
    }
    return l;
  }
  private parseMul(): Expr {
    let l = this.parseUnary();
    while (["*", "/", "%"].includes(this.peek()?.text ?? "")) {
      const op = this.next().text;
      const r = this.parseUnary();
      l = { id: nid(), kind: "binary", op, left: l, right: r };
    }
    return l;
  }
  private parseUnary(): Expr {
    const t = this.peek();
    if (t?.text === "-" || t?.text === "not") {
      this.next();
      return { id: nid(), kind: "unary", op: t.text, arg: this.parseUnary() };
    }
    if (t?.text === "+") { this.next(); return this.parseUnary(); }
    return this.parsePostfix();
  }
  private parsePostfix(): Expr {
    let e = this.parseAtom();
    for (;;) {
      const t = this.peek();
      if (t?.text === "[") {
        this.next();
        const off = this.parseTernary();
        if (this.next().text !== "]") this.fail("Kurung sejarah butuh ']'");
        e = { id: nid(), kind: "hist", target: e, offset: off };
        continue;
      }
      if (t?.text === "(" && e.kind === "ident") {
        this.next();
        const args: { name: string | null; value: Expr }[] = [];
        if (this.peek()?.text !== ")") {
          for (;;) {
            // named argument: ident '=' (but not '==')
            const save = this.pos;
            const maybeName = this.peek();
            const after = this.toks[this.pos + 1];
            if (maybeName?.kind === "ident" && after?.text === "=" && !maybeName.text.includes(".")) {
              this.pos += 2;
              args.push({ name: maybeName.text, value: this.parseTernary() });
            } else {
              this.pos = save;
              args.push({ name: null, value: this.parseTernary() });
            }
            if (this.peek()?.text === ",") { this.next(); continue; }
            break;
          }
        }
        if (this.next().text !== ")") this.fail("Panggilan fungsi butuh ')'");
        e = { id: nid(), kind: "call", name: e.name, args };
        continue;
      }
      break;
    }
    return e;
  }
  private parseAtom(): Expr {
    const t = this.next();
    if (t.kind === "num") return { id: nid(), kind: "num", value: Number(t.text) };
    if (t.kind === "str") return { id: nid(), kind: "str", value: t.text };
    if (t.kind === "ident") {
      if (t.text === "true") return { id: nid(), kind: "bool", value: true };
      if (t.text === "false") return { id: nid(), kind: "bool", value: false };
      if (t.text === "na") return { id: nid(), kind: "na" };
      return { id: nid(), kind: "ident", name: t.text };
    }
    if (t.text === "(") {
      const e = this.parseTernary();
      if (this.next().text !== ")") this.fail("Kurung butuh ')'");
      return e;
    }
    return this.fail(`Token tak terduga: '${t.text}'`);
  }
}

function parseExpr(text: string, lineNo: number): Expr {
  return new ExprParser(tokenize(text, lineNo), lineNo).parseFull();
}

// ---------------------------------------------------------------- statements

type Stmt =
  | { kind: "assign"; targets: string[]; expr: Expr; isVar: boolean; reassign: boolean; lineNo: number }
  | { kind: "expr"; expr: Expr; lineNo: number }
  | { kind: "if"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null; lineNo: number }
  | { kind: "for"; varName: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; lineNo: number }
  | { kind: "funcdef"; name: string; params: string[]; body: Stmt[]; ret: Expr | null; lineNo: number }
  | { kind: "header"; expr: Expr; lineNo: number };

function parseBlock(lines: LineNode[]): Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const text = line.text;

    if (/^(indicator|study|strategy)\s*\(/.test(text)) {
      out.push({ kind: "header", expr: parseExpr(text, line.lineNo), lineNo: line.lineNo });
      continue;
    }
    if (/^if\s+/.test(text)) {
      const cond = parseExpr(text.replace(/^if\s+/, ""), line.lineNo);
      const thenBody = parseBlock(line.children);
      let elseBody: Stmt[] | null = null;
      const nextLine = lines[i + 1];
      if (nextLine && /^else\b/.test(nextLine.text) && nextLine.indent === line.indent) {
        elseBody = parseBlock(nextLine.children);
        i++;
      }
      out.push({ kind: "if", cond, thenBody, elseBody, lineNo: line.lineNo });
      continue;
    }
    if (/^for\s+/.test(text)) {
      const m = text.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s+to\s+(.+?)(?:\s+by\s+(.+))?$/);
      if (!m) throw new PineError(`Baris ${line.lineNo}: Sintaks for tidak dikenal`);
      out.push({
        kind: "for",
        varName: m[1] ?? "i",
        from: parseExpr(m[2] ?? "0", line.lineNo),
        to: parseExpr(m[3] ?? "0", line.lineNo),
        step: m[4] ? parseExpr(m[4], line.lineNo) : null,
        body: parseBlock(line.children),
        lineNo: line.lineNo,
      });
      continue;
    }
    // function definition: name(params) => ...
    const fnMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*=>(.*)$/);
    if (fnMatch) {
      const params = (fnMatch[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^(?:int|float|bool|string|color|series\s+\w+)\s+/, ""));
      const rest = (fnMatch[3] ?? "").trim();
      if (rest) {
        out.push({ kind: "funcdef", name: fnMatch[1] ?? "", params, body: [], ret: parseExpr(rest, line.lineNo), lineNo: line.lineNo });
      } else {
        const bodyLines = line.children;
        const bodyStmts = parseBlock(bodyLines.slice(0, -1));
        const last = bodyLines[bodyLines.length - 1];
        out.push({
          kind: "funcdef",
          name: fnMatch[1] ?? "",
          params,
          body: bodyStmts,
          ret: last ? parseExpr(last.text, last.lineNo) : null,
          lineNo: line.lineNo,
        });
      }
      continue;
    }
    // destructuring assignment: [a, b] = expr  |  [a, b] := expr
    const destr = text.match(/^\[([^\]]+)\]\s*(:?=)\s*(.+)$/);
    if (destr) {
      const targets = (destr[1] ?? "").split(",").map((s) => s.trim());
      out.push({ kind: "assign", targets, expr: parseExpr(destr[3] ?? "", line.lineNo), isVar: false, reassign: destr[2] === ":=", lineNo: line.lineNo });
      continue;
    }
    // assignment: [var|varip] [type] name (=|:=) expr
    const assign = text.match(/^(?:(varip|var)\s+)?(?:(?:int|float|bool|string|color|series)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(:?=)\s*(.+)$/);
    if (assign && !/^(if|for|else)\b/.test(text)) {
      out.push({
        kind: "assign",
        targets: [assign[2] ?? ""],
        expr: parseExpr(assign[4] ?? "", line.lineNo),
        isVar: !!assign[1],
        reassign: assign[3] === ":=",
        lineNo: line.lineNo,
      });
      continue;
    }
    out.push({ kind: "expr", expr: parseExpr(text, line.lineNo), lineNo: line.lineNo });
  }
  return out;
}

// ---------------------------------------------------------------- runtime

type FuncDef = { params: string[]; body: Stmt[]; ret: Expr | null };

type Runtime = {
  n: number;
  bar: number;
  scopes: Map<string, Series>[]; // scope stack; series per variable
  funcs: Map<string, FuncDef>;
  callState: Map<string, Series>; // per ta-call-site output series cache
  nodeHist: Map<number, Series>; // per AST-node value history (for expr[n])
  plots: PlotOutput[];
  inputs: InputDef[];
  inputOverrides: Record<string, number | boolean | string>;
  overlay: boolean;
  scriptName: string;
  depth: number;
};

const COLOR_CONSTANTS: Record<string, string> = {
  "color.red": "#F23645", "color.green": "#089981", "color.blue": "#2962FF",
  "color.orange": "#FF6D00", "color.purple": "#9C27B0", "color.yellow": "#FFEB3B",
  "color.white": "#FFFFFF", "color.black": "#000000", "color.gray": "#787B86",
  "color.grey": "#787B86", "color.aqua": "#00BCD4", "color.fuchsia": "#E040FB",
  "color.lime": "#00E676", "color.maroon": "#880E4F", "color.navy": "#1A237E",
  "color.olive": "#808000", "color.silver": "#C0C0C0", "color.teal": "#008080",
};

const CONSTANTS: Record<string, Value> = {
  ...COLOR_CONSTANTS,
  "plot.style_line": "line", "plot.style_stepline": "line", "plot.style_linebr": "line",
  "plot.style_area": "area", "plot.style_areabr": "area",
  "plot.style_columns": "columns", "plot.style_histogram": "histogram",
  "plot.style_circles": "circles", "plot.style_cross": "cross",
  "shape.circle": "circle", "shape.square": "square", "shape.triangleup": "triangleup",
  "shape.triangledown": "triangledown", "shape.diamond": "diamond", "shape.xcross": "xcross",
  "shape.cross": "cross", "shape.flag": "flag", "shape.arrowup": "arrowup", "shape.arrowdown": "arrowdown",
  "shape.labelup": "labelup", "shape.labeldown": "labeldown",
  "location.abovebar": "abovebar", "location.belowbar": "belowbar",
  "location.top": "top", "location.bottom": "bottom",
  "size.auto": "auto", "size.tiny": "tiny", "size.small": "small", "size.normal": "normal", "size.large": "large", "size.huge": "huge",
  "line.style_solid": "solid", "line.style_dashed": "dashed", "line.style_dotted": "dotted",
  "extend.none": "none", "extend.right": "right", "extend.both": "both",
  "format.price": "price", "format.volume": "volume", "format.percent": "percent",
  "xloc.bar_index": "bar_index", "xloc.bar_time": "bar_time",
  "yloc.price": "price", "yloc.abovebar": "abovebar", "yloc.belowbar": "belowbar",
};

function lookupVar(rt: Runtime, name: string): Value {
  if (name in CONSTANTS) return CONSTANTS[name] ?? NA;
  for (let s = rt.scopes.length - 1; s >= 0; s--) {
    const scope = rt.scopes[s];
    const series = scope?.get(name);
    if (series) return series;
  }
  throw new PineError(`Variabel/fungsi tidak dikenal: '${name}'`);
}

function currentScope(rt: Runtime): Map<string, Series> {
  const scope = rt.scopes[rt.scopes.length - 1];
  if (!scope) throw new PineError("Scope hilang");
  return scope;
}

function setVar(rt: Runtime, name: string, value: Value, reassign: boolean): void {
  // Find the scope that already owns the variable when reassigning.
  let scope: Map<string, Series> | undefined;
  if (reassign) {
    for (let s = rt.scopes.length - 1; s >= 0; s--) {
      if (rt.scopes[s]?.has(name)) { scope = rt.scopes[s]; break; }
    }
  }
  scope = scope ?? currentScope(rt);
  let series = scope.get(name);
  if (!series) {
    series = new Array(rt.n).fill(NA) as Series;
    scope.set(name, series);
  }
  if (isTuple(value)) {
    series[rt.bar] = NA;
    return;
  }
  if (isSeries(value)) {
    series[rt.bar] = value[rt.bar] ?? NA;
  } else {
    series[rt.bar] = value as Scalar;
  }
}

function getVarSeries(rt: Runtime, name: string): Series {
  for (let s = rt.scopes.length - 1; s >= 0; s--) {
    const series = rt.scopes[s]?.get(name);
    if (series) return series;
  }
  throw new PineError(`Variabel tidak dikenal: '${name}'`);
}

/** Current-bar scalar of a value (series → value at bar). */
function cur(rt: Runtime, v: Value): Scalar {
  if (isTuple(v)) throw new PineError("Tuple tidak bisa dipakai sebagai nilai tunggal");
  if (isSeries(v)) return v[rt.bar] ?? NA;
  return v as Scalar;
}

function asSeries(rt: Runtime, v: Value): Series {
  if (isTuple(v)) throw new PineError("Tuple tidak bisa dipakai sebagai series");
  if (isSeries(v)) return v;
  const s = new Array(rt.n).fill(v as Scalar) as Series;
  return s;
}

function num(rt: Runtime, v: Value): number | null {
  const c = cur(rt, v);
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

function truthy(rt: Runtime, v: Value): boolean {
  const c = cur(rt, v);
  return c === true || (typeof c === "number" && c !== 0);
}

// ------------------------------------------------------------ ta helpers

function windowed(rt: Runtime, nodeId: number, src: Value, len: number | null, fn: (vals: number[]) => number | null): Value {
  const series = asSeries(rt, src);
  const key = `ta:${nodeId}`;
  let out = rt.callState.get(key);
  if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
  if (out[rt.bar] !== NA && out[rt.bar] !== undefined) return out;
  const L = len ?? 0;
  const vals: number[] = [];
  for (let i = Math.max(0, rt.bar - L + 1); i <= rt.bar; i++) {
    const v = series[i];
    if (typeof v === "number") vals.push(v);
  }
  out[rt.bar] = L > 0 && vals.length < L ? NA : fn(vals);
  return out;
}

function emaLike(rt: Runtime, nodeId: number, src: Value, len: number, kind: "ema" | "rma"): Value {
  const series = asSeries(rt, src);
  const key = `ta:${nodeId}`;
  let out = rt.callState.get(key);
  if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
  if (out[rt.bar] !== NA && out[rt.bar] !== undefined) return out;
  const alpha = kind === "ema" ? 2 / (len + 1) : 1 / len;
  const prev = rt.bar > 0 ? out[rt.bar - 1] : NA;
  const sv = series[rt.bar];
  if (typeof sv !== "number") { out[rt.bar] = prev ?? NA; return out; }
  if (prev === NA || prev === null || prev === undefined) {
    // Seed with SMA of the first `len` values when available.
    if (rt.bar >= len - 1) {
      let sum = 0; let cnt = 0;
      for (let i = rt.bar - len + 1; i <= rt.bar; i++) { const v = series[i]; if (typeof v === "number") { sum += v; cnt++; } }
      out[rt.bar] = cnt === len ? sum / len : NA;
    } else out[rt.bar] = NA;
  } else {
    out[rt.bar] = alpha * sv + (1 - alpha) * (prev as number);
  }
  return out;
}

/** WMA of a full series at one bar; null when the window is incomplete. */
function wmaAt(s: Series, bar: number, len: number): number | null {
  if (len < 1 || bar < len - 1) return null;
  let wsum = 0;
  let vsum = 0;
  for (let i = 0; i < len; i++) {
    const v = s[bar - len + 1 + i];
    if (typeof v !== "number") return null;
    const w = i + 1;
    wsum += w;
    vsum += v * w;
  }
  return wsum ? vsum / wsum : null;
}

// ------------------------------------------------------------ eval

/** Store a per-bar scalar into the node's cached series and return it, so
 *  series-typed expressions (close * volume, etc.) stay series. */
function seriesResult(rt: Runtime, nodeId: number, value: Scalar): Series {
  const key = `node:${nodeId}`;
  let s = rt.callState.get(key);
  if (!s) { s = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, s); }
  s[rt.bar] = value;
  return s;
}

function evalExpr(rt: Runtime, e: Expr): Value {
  let result: Value;
  switch (e.kind) {
    case "num": result = e.value; break;
    case "str": result = e.value; break;
    case "bool": result = e.value; break;
    case "na": result = NA; break;
    case "ident": result = lookupVar(rt, e.name); break;
    case "unary": {
      const a = evalExpr(rt, e.arg);
      let scalar: Scalar;
      if (e.op === "not") scalar = !truthy(rt, a);
      else {
        const v = num(rt, a);
        scalar = v === null ? NA : -v;
      }
      result = isSeries(a) ? seriesResult(rt, e.id, scalar) : scalar;
      break;
    }
    case "binary": result = evalBinary(rt, e); break;
    case "ternary": {
      const cond = evalExpr(rt, e.cond);
      const chosen = truthy(rt, cond) ? evalExpr(rt, e.then) : evalExpr(rt, e.els);
      const seriesTyped = isSeries(cond) || isSeries(chosen);
      result = seriesTyped && !isTuple(chosen) ? seriesResult(rt, e.id, cur(rt, chosen)) : chosen;
      break;
    }
    case "hist": {
      const offRaw = num(rt, evalExpr(rt, e.offset));
      const off = offRaw === null ? 0 : Math.max(0, Math.floor(offRaw));
      const idx = rt.bar - off;
      if (idx < 0) { result = NA; break; }
      if (e.target.kind === "ident") {
        const s = getVarSeries(rt, e.target.name);
        result = s[idx] ?? NA;
        break;
      }
      const tv = evalExpr(rt, e.target);
      if (isSeries(tv)) { result = tv[idx] ?? NA; break; }
      const hist = rt.nodeHist.get(e.target.id);
      result = hist ? (hist[idx] ?? NA) : NA;
      break;
    }
    case "call": result = evalCall(rt, e); break;
    default: result = NA;
  }
  // Record node history for expr[n] support.
  if (!isSeries(result) && !isTuple(result)) {
    let h = rt.nodeHist.get(e.id);
    if (!h) { h = new Array(rt.n).fill(NA) as Series; rt.nodeHist.set(e.id, h); }
    h[rt.bar] = result as Scalar;
  }
  return result;
}

function evalBinary(rt: Runtime, node: Extract<Expr, { kind: "binary" }>): Value {
  const { op, left: le, right: re } = node;
  if (op === "and" || op === "or") {
    const l = evalExpr(rt, le);
    const r = evalExpr(rt, re);
    const scalar = op === "and" ? truthy(rt, l) && truthy(rt, r) : truthy(rt, l) || truthy(rt, r);
    return isSeries(l) || isSeries(r) ? seriesResult(rt, node.id, scalar) : scalar;
  }
  const l = evalExpr(rt, le);
  const r = evalExpr(rt, re);
  const lv = cur(rt, l);
  const rv = cur(rt, r);
  let scalar: Scalar;
  switch (op) {
    case "==": scalar = lv === rv; break;
    case "!=": scalar = lv !== rv; break;
    case ">": case "<": case ">=": case "<=": {
      if (typeof lv !== "number" || typeof rv !== "number") scalar = false;
      else scalar = op === ">" ? lv > rv : op === "<" ? lv < rv : op === ">=" ? lv >= rv : lv <= rv;
      break;
    }
    case "+": {
      if (typeof lv === "string" && typeof rv === "string") scalar = lv + rv;
      else if (typeof lv !== "number" || typeof rv !== "number") scalar = NA;
      else scalar = lv + rv;
      break;
    }
    case "-": scalar = typeof lv === "number" && typeof rv === "number" ? lv - rv : NA; break;
    case "*": scalar = typeof lv === "number" && typeof rv === "number" ? lv * rv : NA; break;
    case "/": scalar = typeof lv === "number" && typeof rv === "number" && rv !== 0 ? lv / rv : NA; break;
    case "%": scalar = typeof lv === "number" && typeof rv === "number" && rv !== 0 ? lv % rv : NA; break;
    default: scalar = NA;
  }
  return isSeries(l) || isSeries(r) ? seriesResult(rt, node.id, scalar) : scalar;
}

// ------------------------------------------------------------ calls

function argVal(rt: Runtime, e: { args: { name: string | null; value: Expr }[] }, index: number, name: string): Value | undefined {
  const named = e.args.find((a) => a.name === name);
  if (named) return evalExpr(rt, named.value);
  const positional = e.args.filter((a) => a.name === null);
  const p = positional[index];
  return p ? evalExpr(rt, p.value) : undefined;
}

function argNum(rt: Runtime, e: { args: { name: string | null; value: Expr }[] }, index: number, name: string, def?: number): number | null {
  const v = argVal(rt, e, index, name);
  if (v === undefined) return def ?? null;
  return num(rt, v);
}

function toRgba(hex: string, transp: number): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, 1 - transp / 100));
  return `rgba(${r},${g},${b},${a})`;
}

function evalCall(rt: Runtime, e: Extract<Expr, { kind: "call" }>): Value {
  const name = e.name;

  // User-defined function
  const fn = rt.funcs.get(name);
  if (fn) {
    if (rt.depth > 50) throw new PineError("Rekursi fungsi terlalu dalam");
    const local = new Map<string, Series>();
    fn.params.forEach((p, i) => {
      const v = argVal(rt, e, i, p);
      const s = new Array(rt.n).fill(NA) as Series;
      if (v !== undefined) {
        if (isSeries(v)) { for (let k = 0; k < rt.n; k++) s[k] = v[k] ?? NA; }
        else if (!isTuple(v)) s[rt.bar] = v as Scalar;
      }
      local.set(p, s);
    });
    rt.scopes.push(local);
    rt.depth++;
    try {
      execBlock(rt, fn.body);
      return fn.ret ? evalExpr(rt, fn.ret) : NA;
    } finally {
      rt.scopes.pop();
      rt.depth--;
    }
  }

  switch (name) {
    // ---------------------------------------------------------- header
    case "indicator":
    case "study": {
      const title = argVal(rt, e, 0, "title");
      if (typeof title === "string") rt.scriptName = title;
      const ov = argVal(rt, e, 1, "overlay");
      if (typeof ov === "boolean") rt.overlay = ov;
      return NA;
    }
    case "strategy":
      throw new PineError("strategy() tidak didukung — terminal ini untuk indikator saja. Pakai indicator().");

    // ---------------------------------------------------------- inputs
    case "input":
    case "input.int":
    case "input.float":
    case "input.bool":
    case "input.source":
    case "input.string":
    case "input.color":
    case "input.session":
    case "input.timeframe": {
      const defval = argVal(rt, e, 0, "defval");
      const titleV = argVal(rt, e, 1, "title");
      const title = typeof titleV === "string" ? titleV : `Input ${rt.inputs.length + 1}`;
      const type: InputDef["type"] =
        name === "input.int" ? "int" :
        name === "input.float" ? "float" :
        name === "input.bool" ? "bool" :
        name === "input.source" ? "source" :
        name === "input.string" || name === "input.session" || name === "input.timeframe" ? "string" : "float";
      const key = `${name}:${title}`;
      if (!rt.inputs.some((i) => i.key === key)) {
        const def: InputDef = {
          key,
          title,
          type,
          defval: (defval === undefined || isSeries(defval) || isTuple(defval)) ? (type === "source" ? "close" : type === "bool" ? false : type === "string" ? "" : 0) : (defval as number | boolean | string),
          min: argNum(rt, e, 2, "minval") ?? undefined,
          max: argNum(rt, e, 3, "maxval") ?? undefined,
          step: argNum(rt, e, 4, "step") ?? undefined,
        };
        const opts = argVal(rt, e, 5, "options");
        if (typeof opts === "string") def.options = [opts];
        rt.inputs.push(def);
      }
      const override = rt.inputOverrides[key];
      if (override !== undefined) {
        if (type === "source" && typeof override === "string") return lookupVar(rt, override);
        return override;
      }
      return defval === undefined ? NA : defval;
    }

    // ---------------------------------------------------------- plots
    case "plot": {
      const series = argVal(rt, e, 0, "series");
      if (series === undefined) throw new PineError("plot() butuh argumen series");
      const titleV = argVal(rt, e, 1, "title");
      const styleV = argVal(rt, e, 3, "style");
      const colorV = argVal(rt, e, 2, "color");
      const lwV = argNum(rt, e, 4, "linewidth");
      registerPlot(rt, e.id, {
        title: typeof titleV === "string" ? titleV : "Plot",
        kind: (typeof styleV === "string" ? styleV : "line") as PlotKind,
        series,
        colorV,
        lineWidth: lwV ?? 1,
      });
      // Return a reference token so fill(ma1, ma2, ...) can find this plot.
      return `plotref:plot:${e.id}`;
    }
    case "plotshape":
    case "plotchar": {
      const series = argVal(rt, e, 0, "series");
      if (series === undefined) throw new PineError(`${name}() butuh argumen series`);
      const titleV = argVal(rt, e, 1, "title") ?? argVal(rt, e, 2, "text");
      const colorV = argVal(rt, e, 5, "color") ?? argVal(rt, e, 3, "color");
      // Boolean series → marker where true; numeric series → marker where non-na.
      const boolSeries = asSeries(rt, series).map((v) => (v === true || (typeof v === "number" && v !== 0) ? 1 : NA)) as Series;
      registerPlot(rt, e.id, {
        title: typeof titleV === "string" ? titleV : "Shape",
        kind: "shapes",
        series: boolSeries,
        colorV,
        lineWidth: 1,
      });
      return NA;
    }
    case "hline": {
      const price = argNum(rt, e, 0, "price");
      const titleV = argVal(rt, e, 1, "title");
      const colorV = argVal(rt, e, 2, "color");
      if (price !== null) {
        const key = `hline:${e.id}`;
        let plot = rt.plots.find((p) => (p as PlotOutput & { key?: string }).key === key);
        if (!plot) {
          plot = {
            title: typeof titleV === "string" ? titleV : `HLine ${price}`,
            kind: "hline",
            values: new Array(rt.n).fill(price) as (number | null)[],
            color: typeof colorV === "string" ? colorV : "#787B86",
            colors: null,
            lineWidth: 1,
            overlay: rt.overlay,
          };
          (plot as PlotOutput & { key?: string }).key = key;
          rt.plots.push(plot);
        }
      }
      return NA;
    }
    case "bgcolor": {
      const colorV = argVal(rt, e, 0, "color");
      registerPlot(rt, e.id, {
        title: "bgcolor",
        kind: "bgcolor",
        series: new Array(rt.n).fill(1) as Series,
        colorV,
        lineWidth: 0,
      });
      return NA;
    }
    case "fill": {
      // fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color)
      // or fill(plot1, plot2, color) / fill(plot1, plot2, top_color, bottom_color)
      // with the band edges taken from the two plots themselves.
      const resolvePlot = (v: Value | undefined): PlotOutput | undefined => {
        if (v === undefined) return undefined;
        const token = cur(rt, v);
        if (typeof token !== "string" || !token.startsWith("plotref:")) return undefined;
        const key = token.slice("plotref:".length);
        return rt.plots.find((p) => (p as PlotOutput & { key?: string }).key === key);
      };
      const plot1 = resolvePlot(argVal(rt, e, 0, "plot1"));
      const plot2 = resolvePlot(argVal(rt, e, 1, "plot2"));
      const positionalCount = e.args.filter((a) => a.name === null).length;
      const hasNamedValues = e.args.some((a) => a.name === "top_value" || a.name === "bottom_value");
      let top: number | null;
      let bottom: number | null;
      let topColor: string | null;
      let bottomColor: string | null;
      const colorAt = (v: Value | undefined): string | null => {
        if (v === undefined) return null;
        const c = cur(rt, v);
        return typeof c === "string" ? c : null;
      };
      if (positionalCount >= 5 || hasNamedValues) {
        top = argNum(rt, e, 2, "top_value");
        bottom = argNum(rt, e, 3, "bottom_value");
        topColor = colorAt(argVal(rt, e, 4, "top_color"));
        bottomColor = colorAt(argVal(rt, e, 5, "bottom_color"));
      } else {
        const v1 = plot1?.values[rt.bar];
        const v2 = plot2?.values[rt.bar];
        top = typeof v1 === "number" && typeof v2 === "number" ? Math.max(v1, v2) : null;
        bottom = typeof v1 === "number" && typeof v2 === "number" ? Math.min(v1, v2) : null;
        if (positionalCount >= 4 || e.args.some((a) => a.name === "bottom_color")) {
          topColor = colorAt(argVal(rt, e, 2, "top_color"));
          bottomColor = colorAt(argVal(rt, e, 3, "bottom_color"));
        } else {
          topColor = colorAt(argVal(rt, e, 2, "color"));
          bottomColor = topColor;
        }
      }
      const titleV = argVal(rt, e, 6, "title");
      const key = `plot:${e.id}`;
      let plot = rt.plots.find((p) => (p as PlotOutput & { key?: string }).key === key);
      if (!plot) {
        plot = {
          title: typeof titleV === "string" ? titleV : "Fill",
          kind: "fill",
          values: new Array(rt.n).fill(NA) as (number | null)[],
          color: topColor ?? "#2962FF",
          colors: new Array(rt.n).fill(NA) as (string | null)[],
          lineWidth: 0,
          overlay: rt.overlay,
          fillBottom: new Array(rt.n).fill(NA) as (number | null)[],
          fillBottomColors: new Array(rt.n).fill(NA) as (string | null)[],
        };
        (plot as PlotOutput & { key?: string }).key = key;
        rt.plots.push(plot);
      }
      plot.values[rt.bar] = top;
      if (plot.fillBottom) plot.fillBottom[rt.bar] = bottom;
      if (plot.colors) plot.colors[rt.bar] = topColor;
      if (plot.fillBottomColors) plot.fillBottomColors[rt.bar] = bottomColor;
      return NA;
    }

    // ---------------------------------------------------------- color
    case "color.new": {
      const base = argVal(rt, e, 0, "color");
      const transpV = argVal(rt, e, 1, "transp");
      const transp = transpV === undefined ? 0 : (num(rt, transpV) ?? 0);
      const baseCur = base === undefined ? undefined : cur(rt, base);
      const hex = typeof baseCur === "string" && baseCur.startsWith("#") ? baseCur : "#FFFFFF";
      const rgba = toRgba(hex, transp);
      // Keep the result series-typed when an input is a series so plots
      // get per-bar colors (e.g. a trend color that flips with direction).
      return (base !== undefined && isSeries(base)) || (transpV !== undefined && isSeries(transpV))
        ? seriesResult(rt, e.id, rgba)
        : rgba;
    }
    case "color.rgb": {
      const r = argNum(rt, e, 0, "red") ?? 0;
      const g = argNum(rt, e, 1, "green") ?? 0;
      const b = argNum(rt, e, 2, "blue") ?? 0;
      const transp = argNum(rt, e, 3, "transp") ?? 0;
      return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, 1 - transp / 100))})`;
    }

    // ---------------------------------------------------------- misc
    case "na": {
      const v = argVal(rt, e, 0, "x");
      return v === undefined ? true : cur(rt, v) === NA;
    }
    case "nz": {
      const v = argVal(rt, e, 0, "x");
      const repl = argNum(rt, e, 1, "replacement") ?? 0;
      const c = v === undefined ? null : num(rt, v);
      return c === null ? repl : c;
    }
    case "fixnan": {
      const v = argVal(rt, e, 0, "source");
      if (v === undefined) return NA;
      const s = asSeries(rt, v);
      for (let i = rt.bar; i >= 0; i--) { if (typeof s[i] === "number") return s[i] as number; }
      return NA;
    }

    // ---------------------------------------------------------- math
    case "math.abs": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null ? NA : Math.abs(v); }
    case "math.max": {
      const vals = e.args.map((a) => num(rt, evalExpr(rt, a.value))).filter((v): v is number => v !== null);
      return vals.length ? Math.max(...vals) : NA;
    }
    case "math.min": {
      const vals = e.args.map((a) => num(rt, evalExpr(rt, a.value))).filter((v): v is number => v !== null);
      return vals.length ? Math.min(...vals) : NA;
    }
    case "math.avg": {
      const vals = e.args.map((a) => num(rt, evalExpr(rt, a.value))).filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NA;
    }
    case "math.sqrt": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null || v < 0 ? NA : Math.sqrt(v); }
    case "math.pow": { const b = num(rt, argVal(rt, e, 0, "base") ?? NA); const ex = num(rt, argVal(rt, e, 1, "exponent") ?? NA); return b === null || ex === null ? NA : Math.pow(b, ex); }
    case "math.log": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null || v <= 0 ? NA : Math.log(v); }
    case "math.exp": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null ? NA : Math.exp(v); }
    case "math.floor": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null ? NA : Math.floor(v); }
    case "math.ceil": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null ? NA : Math.ceil(v); }
    case "math.round": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); const p = argNum(rt, e, 1, "precision") ?? 0; return v === null ? NA : Math.round(v * Math.pow(10, p)) / Math.pow(10, p); }
    case "math.sign": { const v = num(rt, argVal(rt, e, 0, "x") ?? NA); return v === null ? NA : Math.sign(v); }

    // ---------------------------------------------------------- ta.*
    case "ta.sma": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      return windowed(rt, e.id, src, len, (vals) => vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    case "ta.ema": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return len > 0 ? emaLike(rt, e.id, src, len, "ema") : NA; }
    case "ta.rma": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return len > 0 ? emaLike(rt, e.id, src, len, "rma") : NA; }
    case "ta.wma": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      return windowed(rt, e.id, src, len, (vals) => {
        let wsum = 0; let vsum = 0;
        vals.forEach((v, i) => { const w = i + 1; wsum += w; vsum += v * w; });
        return wsum ? vsum / wsum : NA;
      });
    }
    case "ta.vwma": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      const vol = getVarSeries(rt, "volume");
      const s = asSeries(rt, src);
      return windowed(rt, e.id, src, len, () => {
        let pv = 0; let vv = 0;
        for (let i = Math.max(0, rt.bar - len + 1); i <= rt.bar; i++) {
          const p = s[i]; const v = vol[i];
          if (typeof p === "number" && typeof v === "number") { pv += p * v; vv += v; }
        }
        return vv ? pv / vv : NA;
      });
    }
    case "ta.hma": {
      // HMA = WMA(2*WMA(src, len/2) - WMA(src, len), sqrt(len))
      const src = asSeries(rt, argVal(rt, e, 0, "source") ?? NA);
      const len = argNum(rt, e, 1, "length") ?? 0;
      if (len < 1) return NA;
      const key = `ta:${e.id}`;
      let out = rt.callState.get(key);
      if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
      if (out[rt.bar] !== NA && out[rt.bar] !== undefined) return out;
      const half = Math.max(1, Math.floor(len / 2));
      const sq = Math.max(1, Math.round(Math.sqrt(len)));
      const diffAt = (j: number): number | null => {
        const a = wmaAt(src, j, half);
        const b = wmaAt(src, j, len);
        return a !== null && b !== null ? 2 * a - b : null;
      };
      let wsum = 0;
      let vsum = 0;
      let ok = true;
      for (let i = 0; i < sq; i++) {
        const d = diffAt(rt.bar - sq + 1 + i);
        if (d === null) { ok = false; break; }
        const w = i + 1;
        wsum += w;
        vsum += d * w;
      }
      out[rt.bar] = ok && wsum ? vsum / wsum : NA;
      return out;
    }
    case "ta.highest": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return windowed(rt, e.id, src, len, (vals) => Math.max(...vals)); }
    case "ta.lowest": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return windowed(rt, e.id, src, len, (vals) => Math.min(...vals)); }
    case "ta.highestbars": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return windowed(rt, e.id, src, len, (vals) => -(vals.length - 1 - vals.indexOf(Math.max(...vals)))); }
    case "ta.lowestbars": { const src = argVal(rt, e, 0, "source") ?? NA; const len = argNum(rt, e, 1, "length") ?? 0; return windowed(rt, e.id, src, len, (vals) => -(vals.length - 1 - vals.indexOf(Math.min(...vals)))); }
    case "ta.sum": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      return windowed(rt, e.id, src, len, (vals) => vals.reduce((a, b) => a + b, 0));
    }
    case "ta.cum": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const s = asSeries(rt, src);
      const key = `ta:${e.id}`;
      let out = rt.callState.get(key);
      if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
      if (out[rt.bar] === NA || out[rt.bar] === undefined) {
        const prev = rt.bar > 0 ? (out[rt.bar - 1] as number | null) : 0;
        const v = s[rt.bar];
        out[rt.bar] = typeof v === "number" ? (prev ?? 0) + v : (prev ?? NA);
      }
      return out;
    }
    case "ta.change": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 1;
      const s = asSeries(rt, src);
      const a = s[rt.bar]; const b = s[rt.bar - len];
      return typeof a === "number" && typeof b === "number" ? a - b : NA;
    }
    case "ta.mom": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 1;
      const s = asSeries(rt, src);
      const a = s[rt.bar]; const b = s[rt.bar - len];
      return typeof a === "number" && typeof b === "number" ? a - b : NA;
    }
    case "ta.roc": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 1;
      const s = asSeries(rt, src);
      const a = s[rt.bar]; const b = s[rt.bar - len];
      return typeof a === "number" && typeof b === "number" && b !== 0 ? ((a - b) / b) * 100 : NA;
    }
    case "ta.stdev": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      return windowed(rt, e.id, src, len, (vals) => {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      });
    }
    case "ta.variance": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 0;
      return windowed(rt, e.id, src, len, (vals) => {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      });
    }
    case "ta.tr": {
      const handle = argVal(rt, e, 0, "handle_na");
      void handle;
      const h = getVarSeries(rt, "high"); const l = getVarSeries(rt, "low"); const c = getVarSeries(rt, "close");
      const key = `ta:${e.id}`;
      let out = rt.callState.get(key);
      if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
      if (out[rt.bar] === NA || out[rt.bar] === undefined) {
        const hi = h[rt.bar]; const lo = l[rt.bar]; const pc = rt.bar > 0 ? c[rt.bar - 1] : null;
        out[rt.bar] = typeof hi === "number" && typeof lo === "number"
          ? Math.max(hi - lo, typeof pc === "number" ? Math.abs(hi - pc) : 0, typeof pc === "number" ? Math.abs(lo - pc) : 0)
          : NA;
      }
      return out;
    }
    case "ta.atr": {
      const len = argNum(rt, e, 0, "length") ?? 14;
      const trSeries = evalCall(rt, { id: e.id * 100000 + 7, kind: "call", name: "ta.tr", args: [] });
      return len > 0 ? emaLike(rt, e.id, trSeries, len, "rma") : NA;
    }
    case "ta.rsi": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 14;
      const s = asSeries(rt, src);
      const upKey = `rsi-up:${e.id}`; const dnKey = `rsi-dn:${e.id}`;
      const changes = new Array(rt.n).fill(NA) as Series;
      for (let i = 1; i <= rt.bar; i++) {
        const a = s[i]; const b = s[i - 1];
        changes[i] = typeof a === "number" && typeof b === "number" ? a - b : NA;
      }
      const upSrc = changes.map((v) => (typeof v === "number" ? Math.max(v, 0) : NA)) as Series;
      const dnSrc = changes.map((v) => (typeof v === "number" ? Math.max(-v, 0) : NA)) as Series;
      void upKey; void dnKey;
      const up = emaLike(rt, e.id * 1000 + 1, upSrc, len, "rma");
      const dn = emaLike(rt, e.id * 1000 + 2, dnSrc, len, "rma");
      const u = cur(rt, up); const d = cur(rt, dn);
      if (typeof u !== "number" || typeof d !== "number") return NA;
      if (d === 0) return 100;
      return 100 - 100 / (1 + u / d);
    }
    case "ta.macd": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const fast = argNum(rt, e, 1, "fastlen") ?? 12;
      const slow = argNum(rt, e, 2, "slowlen") ?? 26;
      const sig = argNum(rt, e, 3, "siglen") ?? 9;
      const fastE = emaLike(rt, e.id * 1000 + 11, src, fast, "ema");
      const slowE = emaLike(rt, e.id * 1000 + 12, src, slow, "ema");
      const key = `macd:${e.id}`;
      let macdLine = rt.callState.get(key);
      if (!macdLine) { macdLine = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, macdLine); }
      const f = cur(rt, fastE); const s2 = cur(rt, slowE);
      macdLine[rt.bar] = typeof f === "number" && typeof s2 === "number" ? f - s2 : NA;
      const signal = emaLike(rt, e.id * 1000 + 13, macdLine, sig, "ema");
      const m = macdLine[rt.bar]; const sg = cur(rt, signal);
      const hist = typeof m === "number" && typeof sg === "number" ? m - sg : NA;
      return makeTuple([macdLine, signal, histSeries(rt, e.id, hist)]);
    }
    case "ta.stoch": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const h = argVal(rt, e, 1, "high") ?? NA;
      const l = argVal(rt, e, 2, "low") ?? NA;
      const len = argNum(rt, e, 3, "length") ?? 14;
      const hs = asSeries(rt, h); const ls = asSeries(rt, l); const ss = asSeries(rt, src);
      return windowed(rt, e.id, src, len, () => {
        let hi = -Infinity; let lo = Infinity;
        for (let i = Math.max(0, rt.bar - len + 1); i <= rt.bar; i++) {
          const hv = hs[i]; const lv = ls[i];
          if (typeof hv === "number") hi = Math.max(hi, hv);
          if (typeof lv === "number") lo = Math.min(lo, lv);
        }
        const c = ss[rt.bar];
        return typeof c === "number" && hi > lo ? ((c - lo) / (hi - lo)) * 100 : NA;
      });
    }
    case "ta.crossover": case "ta.crossunder": case "ta.cross": {
      const a = asSeries(rt, argVal(rt, e, 0, "source1") ?? NA);
      const b = asSeries(rt, argVal(rt, e, 1, "source2") ?? NA);
      const a0 = a[rt.bar]; const b0 = b[rt.bar];
      const a1 = rt.bar > 0 ? a[rt.bar - 1] : NA; const b1 = rt.bar > 0 ? b[rt.bar - 1] : NA;
      if (typeof a0 !== "number" || typeof b0 !== "number" || typeof a1 !== "number" || typeof b1 !== "number") return false;
      if (name === "ta.crossover") return a1 <= b1 && a0 > b0;
      if (name === "ta.crossunder") return a1 >= b1 && a0 < b0;
      return (a1 <= b1 && a0 > b0) || (a1 >= b1 && a0 < b0);
    }
    case "ta.barssince": {
      const cond = argVal(rt, e, 0, "condition") ?? NA;
      const s = asSeries(rt, cond);
      for (let i = rt.bar; i >= 0; i--) { if (s[i] === true) return rt.bar - i; }
      return NA;
    }
    case "ta.valuewhen": {
      const cond = asSeries(rt, argVal(rt, e, 0, "condition") ?? NA);
      const src = asSeries(rt, argVal(rt, e, 1, "source") ?? NA);
      const occ = argNum(rt, e, 2, "occurrence") ?? 0;
      let seen = 0;
      for (let i = rt.bar; i >= 0; i--) {
        if (cond[i] === true) {
          if (seen === occ) return src[i] ?? NA;
          seen++;
        }
      }
      return NA;
    }
    case "ta.alma": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 9;
      const offset = argNum(rt, e, 2, "offset") ?? 0.85;
      const sigma = argNum(rt, e, 3, "sigma") ?? 6;
      return windowed(rt, e.id, src, len, (vals) => {
        const m = Math.floor(offset * (len - 1));
        const s = len / sigma;
        let wsum = 0; let vsum = 0;
        vals.forEach((v, i) => {
          const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
          wsum += w; vsum += v * w;
        });
        return wsum ? vsum / wsum : NA;
      });
    }
    case "ta.bb": {
      const src = argVal(rt, e, 0, "source") ?? NA;
      const len = argNum(rt, e, 1, "length") ?? 20;
      const mult = argNum(rt, e, 2, "mult") ?? 2;
      const basis = evalCall(rt, { id: e.id * 1000 + 21, kind: "call", name: "ta.sma", args: e.args.slice(0, 2) });
      const dev = evalCall(rt, { id: e.id * 1000 + 22, kind: "call", name: "ta.stdev", args: e.args.slice(0, 2) });
      void src; void len;
      const b = cur(rt, basis); const d = cur(rt, dev);
      if (typeof b !== "number" || typeof d !== "number") return makeTuple([NA, NA, NA]);
      return makeTuple([b, b + mult * d, b - mult * d]);
    }
    case "ta.supertrend": {
      const mult = argNum(rt, e, 0, "factor") ?? 3;
      const len = argNum(rt, e, 1, "atrPeriod") ?? 10;
      const atr = evalCall(rt, { id: e.id * 1000 + 31, kind: "call", name: "ta.atr", args: [{ name: null, value: { id: nid(), kind: "num", value: len } }] });
      const atrV = cur(rt, atr);
      const hl2 = getVarSeries(rt, "hl2");
      const mid = hl2[rt.bar];
      const closeS = getVarSeries(rt, "close");
      const c = closeS[rt.bar];
      if (typeof atrV !== "number" || typeof mid !== "number" || typeof c !== "number") return makeTuple([NA, NA]);
      const getCache = (suffix: string): Series => {
        const key = `st-${suffix}:${e.id}`;
        let s = rt.callState.get(key);
        if (!s) { s = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, s); }
        return s;
      };
      const fuS = getCache("fu"); const flS = getCache("fl");
      const stS = getCache("line"); const dirS = getCache("dir");
      const rawUpper = mid + mult * atrV;
      const rawLower = mid - mult * atrV;
      const prevC = rt.bar > 0 ? closeS[rt.bar - 1] : NA;
      const prevFU = rt.bar > 0 ? fuS[rt.bar - 1] : NA;
      const prevFL = rt.bar > 0 ? flS[rt.bar - 1] : NA;
      const prevSt = rt.bar > 0 ? stS[rt.bar - 1] : NA;
      const fu = typeof prevFU !== "number" || typeof prevC !== "number" || prevC > prevFU ? rawUpper : Math.min(rawUpper, prevFU);
      const fl = typeof prevFL !== "number" || typeof prevC !== "number" || prevC < prevFL ? rawLower : Math.max(rawLower, prevFL);
      fuS[rt.bar] = fu;
      flS[rt.bar] = fl;
      let dir: number;
      if (typeof prevSt !== "number") dir = c >= mid ? 1 : -1;
      else if (prevSt === prevFU) dir = c > fu ? 1 : -1; // was downtrend (sitting on upper band)
      else dir = c < fl ? -1 : 1;
      const st = dir === 1 ? fl : fu;
      stS[rt.bar] = st;
      dirS[rt.bar] = dir;
      return makeTuple([st, dir]);
    }

    default:
      if (name.startsWith("ta.") || name.startsWith("math.") || name.startsWith("input") || name.startsWith("request.") || name.startsWith("str.") || name.startsWith("array.") || name.startsWith("label.") || name.startsWith("line.")) {
        throw new PineError(`Fungsi '${name}' belum didukung di subset Pine terminal ini`);
      }
      throw new PineError(`Fungsi tidak dikenal: '${name}'`);
  }
}

function histSeries(rt: Runtime, nodeId: number, value: Scalar): Series {
  const key = `hist:${nodeId}`;
  let out = rt.callState.get(key);
  if (!out) { out = new Array(rt.n).fill(NA) as Series; rt.callState.set(key, out); }
  out[rt.bar] = value;
  return out;
}

function registerPlot(rt: Runtime, nodeId: number, opts: { title: string; kind: PlotKind; series: Value; colorV: Value | undefined; lineWidth: number }): void {
  const key = `plot:${nodeId}`;
  let plot = rt.plots.find((p) => (p as PlotOutput & { key?: string }).key === key);
  if (!plot) {
    plot = {
      title: opts.title,
      kind: opts.kind,
      values: new Array(rt.n).fill(NA) as (number | null)[],
      color: "#2962FF",
      colors: null,
      lineWidth: opts.lineWidth,
      overlay: rt.overlay,
    };
    (plot as PlotOutput & { key?: string }).key = key;
    rt.plots.push(plot);
  }
  const s = asSeries(rt, opts.series);
  const v = s[rt.bar];
  plot.values[rt.bar] = typeof v === "number" ? v : NA;
  if (opts.colorV !== undefined) {
    if (isSeries(opts.colorV)) {
      if (!plot.colors) plot.colors = new Array(rt.n).fill(NA) as (string | null)[];
      const cv = opts.colorV[rt.bar];
      plot.colors[rt.bar] = typeof cv === "string" ? cv : NA;
    } else if (typeof opts.colorV === "string") {
      plot.color = opts.colorV;
    }
  }
}

// ------------------------------------------------------------ exec

function execBlock(rt: Runtime, stmts: Stmt[]): void {
  for (const st of stmts) execStmt(rt, st);
}

function execStmt(rt: Runtime, st: Stmt): void {
  switch (st.kind) {
    case "header":
      evalExpr(rt, st.expr);
      return;
    case "funcdef":
      rt.funcs.set(st.name, { params: st.params, body: st.body, ret: st.ret });
      return;
    case "assign": {
      if (st.isVar && rt.bar > 0) {
        // var: keep the existing series, carry the value forward; the
        // initializer only runs on the first bar.
        for (const t of st.targets) {
          try {
            const s = getVarSeries(rt, t);
            s[rt.bar] = rt.bar > 0 ? (s[rt.bar - 1] ?? NA) : s[rt.bar] ?? NA;
          } catch { /* not yet defined */ }
        }
        return;
      }
      const value = evalExpr(rt, st.expr);
      if (st.targets.length === 1) {
        setVar(rt, st.targets[0] ?? "", value, st.reassign);
      } else if (isTuple(value)) {
        st.targets.forEach((t, i) => setVar(rt, t, (value as Value[])[i] ?? NA, st.reassign));
      } else {
        st.targets.forEach((t) => setVar(rt, t, NA, st.reassign));
      }
      return;
    }
    case "expr":
      evalExpr(rt, st.expr);
      return;
    case "if": {
      if (truthy(rt, evalExpr(rt, st.cond))) execBlock(rt, st.thenBody);
      else if (st.elseBody) execBlock(rt, st.elseBody);
      return;
    }
    case "for": {
      const from = num(rt, evalExpr(rt, st.from)) ?? 0;
      const to = num(rt, evalExpr(rt, st.to)) ?? 0;
      const step = st.step ? (num(rt, evalExpr(rt, st.step)) ?? 1) : 1;
      const local = new Map<string, Series>();
      const loopSeries = new Array(rt.n).fill(NA) as Series;
      local.set(st.varName, loopSeries);
      rt.scopes.push(local);
      try {
        let guard = 0;
        for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
          if (++guard > 10000) throw new PineError(`Baris ${st.lineNo}: Loop terlalu panjang`);
          loopSeries[rt.bar] = i;
          execBlock(rt, st.body);
        }
      } finally {
        rt.scopes.pop();
      }
      return;
    }
  }
}

// ------------------------------------------------------------ entry point

export function runPineScript(
  source: string,
  candles: Candle[],
  inputOverrides: Record<string, number | boolean | string> = {},
): ScriptResult {
  nextNodeId = 1;
  const n = candles.length;
  const baseScope = new Map<string, Series>();
  const col = (f: (c: Candle) => number): Series => candles.map(f) as Series;
  baseScope.set("open", col((c) => c.open));
  baseScope.set("high", col((c) => c.high));
  baseScope.set("low", col((c) => c.low));
  baseScope.set("close", col((c) => c.close));
  baseScope.set("volume", col((c) => c.volume));
  baseScope.set("hl2", candles.map((c) => (c.high + c.low) / 2) as Series);
  baseScope.set("hlc3", candles.map((c) => (c.high + c.low + c.close) / 3) as Series);
  baseScope.set("ohlc4", candles.map((c) => (c.open + c.high + c.low + c.close) / 4) as Series);
  baseScope.set("time", candles.map((c) => c.time) as Series);
  baseScope.set("bar_index", candles.map((_, i) => i) as Series);
  baseScope.set("last_bar_index", candles.map(() => n - 1) as Series);
  baseScope.set("dayofweek", candles.map((c) => new Date(c.time).getUTCDay() + 1) as Series);
  baseScope.set("hour", candles.map((c) => new Date(c.time).getUTCHours()) as Series);
  baseScope.set("minute", candles.map((c) => new Date(c.time).getUTCMinutes()) as Series);

  const rt: Runtime = {
    n,
    bar: 0,
    scopes: [baseScope],
    funcs: new Map(),
    callState: new Map(),
    nodeHist: new Map(),
    plots: [],
    inputs: [],
    inputOverrides,
    overlay: true,
    scriptName: "Indikator",
    depth: 0,
  };

  try {
    const tree = buildLineTree(source);
    const stmts = parseBlock(tree);
    // Header first (sets name/overlay), regardless of position.
    for (const st of stmts) if (st.kind === "header") evalExpr(rt, st.expr);
    const body = stmts.filter((s) => s.kind !== "header");
    for (let bar = 0; bar < n; bar++) {
      rt.bar = bar;
      execBlock(rt, body);
    }
    return {
      name: rt.scriptName,
      overlay: rt.overlay,
      plots: rt.plots.map((p) => {
        const { key: _key, ...rest } = p as PlotOutput & { key?: string };
        void _key;
        return rest;
      }),
      inputs: rt.inputs,
      error: null,
    };
  } catch (err) {
    return {
      name: rt.scriptName,
      overlay: rt.overlay,
      plots: [],
      inputs: rt.inputs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
