// FVG Order Blocks [BigBeluga], ported to the terminal's Pine subset.
// The original script draws Pine boxes from arrays; this engine has no
// box/array/label support, so each block (max 6 per side, like the
// original Blocks Amount) is held in a var slot and drawn as two edge
// lines plus a translucent fill. Settings match the original defaults
// the user runs: Filter Gaps by % 0.5, Fair Value Gaps on, Broken
// Blocks off, Order Blocks Signals off; bullish #14be94, bearish
// rgb(194, 25, 25). The original's strength gradient and % text are
// not reproduced (no color.from_gradient / str.tostring in the subset).

export const FVG_ORDER_BLOCKS_CODE = `//@version=5
indicator("FVG Order Blocks [BigBeluga]", overlay=true)
// Port BigBeluga "FVG Order Blocks" (CC BY-NC-SA 4.0) ke subset Pine
// terminal ini: box Pine diganti garis tepi + fill per block, maks 6
// block per sisi (Blocks Amount aslinya). Setting persis aslinya:
// Filter Gaps by % 0.5, Fair Value Gaps on, Broken Blocks off, Order
// Blocks Signals off. Bullish #14be94, bearish rgb(194, 25, 25).
// Block bullish: atas = high[2] (tepi bawah gap), bawah = high[2] -
// ATR(200). Block bearish cerminannya dari low[2]. Gradient kekuatan
// gap + teks % aslinya tidak ikut (tidak ada di subset ini). Bar yang
// belum confirmed (bar terakhir) tidak memicu gap baru.
filter = input.float(0.5, "Filter Gaps by %", minval=0, maxval=100, step=0.1)
show_imb = input.bool(true, "Fair Value Gaps")
show_broken = input.bool(false, "Broken Blocks")
show_signal = input.bool(false, "Order Blocks Signals")
col_bull = color.rgb(20, 190, 148)
col_bear = color.rgb(194, 25, 25)
atr = ta.atr(200)
filt_up = (low - high[2]) / low * 100
filt_dn = (low[2] - high) / low[2] * 100
isBull_gap = bar_index < last_bar_index and high[2] < low and high[2] < high[1] and low[2] < low and filt_up > filter
isBear_gap = bar_index < last_bar_index and low[2] > high and low[2] > low[1] and high[2] > high and filt_dn > filter

var float bT1 = na
var float bB1 = na
var bool bK1 = false
var float bT2 = na
var float bB2 = na
var bool bK2 = false
var float bT3 = na
var float bB3 = na
var bool bK3 = false
var float bT4 = na
var float bB4 = na
var bool bK4 = false
var float bT5 = na
var float bB5 = na
var bool bK5 = false
var float bT6 = na
var float bB6 = na
var bool bK6 = false
var float sT1 = na
var float sB1 = na
var bool sK1 = false
var float sT2 = na
var float sB2 = na
var bool sK2 = false
var float sT3 = na
var float sB3 = na
var bool sK3 = false
var float sT4 = na
var float sB4 = na
var bool sK4 = false
var float sT5 = na
var float sB5 = na
var bool sK5 = false
var float sT6 = na
var float sB6 = na
var bool sK6 = false
var float gTopBull = na
var float gBotBull = na
var int gAgeBull = 100
var float gTopBear = na
var float gBotBear = na
var int gAgeBear = 100

gAgeBull := gAgeBull + 1
gAgeBear := gAgeBear + 1

if isBull_gap
    bT6 := bT5
    bB6 := bB5
    bK6 := bK5
    bT5 := bT4
    bB5 := bB4
    bK5 := bK4
    bT4 := bT3
    bB4 := bB3
    bK4 := bK3
    bT3 := bT2
    bB3 := bB2
    bK3 := bK2
    bT2 := bT1
    bB2 := bB1
    bK2 := bK1
    bT1 := high[2]
    bB1 := high[2] - atr
    bK1 := false
    gTopBull := low
    gBotBull := high[2]
    gAgeBull := 0

if isBear_gap
    sT6 := sT5
    sB6 := sB5
    sK6 := sK5
    sT5 := sT4
    sB5 := sB4
    sK5 := sK4
    sT4 := sT3
    sB4 := sB3
    sK4 := sK3
    sT3 := sT2
    sB3 := sB2
    sK3 := sK2
    sT2 := sT1
    sB2 := sB1
    sK2 := sK1
    sT1 := low[2] + atr
    sB1 := low[2]
    sK1 := false
    gTopBear := low[2]
    gBotBear := high
    gAgeBear := 0

if not (bB1 == na) and high < bB1
    if show_broken
        bK1 := true
    else
        bT1 := na
        bB1 := na
if not (bB2 == na) and high < bB2
    if show_broken
        bK2 := true
    else
        bT2 := na
        bB2 := na
if not (bB3 == na) and high < bB3
    if show_broken
        bK3 := true
    else
        bT3 := na
        bB3 := na
if not (bB4 == na) and high < bB4
    if show_broken
        bK4 := true
    else
        bT4 := na
        bB4 := na
if not (bB5 == na) and high < bB5
    if show_broken
        bK5 := true
    else
        bT5 := na
        bB5 := na
if not (bB6 == na) and high < bB6
    if show_broken
        bK6 := true
    else
        bT6 := na
        bB6 := na
if not (sT1 == na) and low > sT1
    if show_broken
        sK1 := true
    else
        sT1 := na
        sB1 := na
if not (sT2 == na) and low > sT2
    if show_broken
        sK2 := true
    else
        sT2 := na
        sB2 := na
if not (sT3 == na) and low > sT3
    if show_broken
        sK3 := true
    else
        sT3 := na
        sB3 := na
if not (sT4 == na) and low > sT4
    if show_broken
        sK4 := true
    else
        sT4 := na
        sB4 := na
if not (sT5 == na) and low > sT5
    if show_broken
        sK5 := true
    else
        sT5 := na
        sB5 := na
if not (sT6 == na) and low > sT6
    if show_broken
        sK6 := true
    else
        sT6 := na
        sB6 := na

if not (bT1 == na) and not (bT2 == na) and bT2 < bT1 and bT2 > bB1
    bT1 := na
    bB1 := na
if not (bT1 == na) and not (bT3 == na) and bT3 < bT1 and bT3 > bB1
    bT1 := na
    bB1 := na
if not (bT1 == na) and not (bT4 == na) and bT4 < bT1 and bT4 > bB1
    bT1 := na
    bB1 := na
if not (bT1 == na) and not (bT5 == na) and bT5 < bT1 and bT5 > bB1
    bT1 := na
    bB1 := na
if not (bT1 == na) and not (bT6 == na) and bT6 < bT1 and bT6 > bB1
    bT1 := na
    bB1 := na
if not (bT2 == na) and not (bT1 == na) and bT1 < bT2 and bT1 > bB2
    bT2 := na
    bB2 := na
if not (bT2 == na) and not (bT3 == na) and bT3 < bT2 and bT3 > bB2
    bT2 := na
    bB2 := na
if not (bT2 == na) and not (bT4 == na) and bT4 < bT2 and bT4 > bB2
    bT2 := na
    bB2 := na
if not (bT2 == na) and not (bT5 == na) and bT5 < bT2 and bT5 > bB2
    bT2 := na
    bB2 := na
if not (bT2 == na) and not (bT6 == na) and bT6 < bT2 and bT6 > bB2
    bT2 := na
    bB2 := na
if not (bT3 == na) and not (bT1 == na) and bT1 < bT3 and bT1 > bB3
    bT3 := na
    bB3 := na
if not (bT3 == na) and not (bT2 == na) and bT2 < bT3 and bT2 > bB3
    bT3 := na
    bB3 := na
if not (bT3 == na) and not (bT4 == na) and bT4 < bT3 and bT4 > bB3
    bT3 := na
    bB3 := na
if not (bT3 == na) and not (bT5 == na) and bT5 < bT3 and bT5 > bB3
    bT3 := na
    bB3 := na
if not (bT3 == na) and not (bT6 == na) and bT6 < bT3 and bT6 > bB3
    bT3 := na
    bB3 := na
if not (bT4 == na) and not (bT1 == na) and bT1 < bT4 and bT1 > bB4
    bT4 := na
    bB4 := na
if not (bT4 == na) and not (bT2 == na) and bT2 < bT4 and bT2 > bB4
    bT4 := na
    bB4 := na
if not (bT4 == na) and not (bT3 == na) and bT3 < bT4 and bT3 > bB4
    bT4 := na
    bB4 := na
if not (bT4 == na) and not (bT5 == na) and bT5 < bT4 and bT5 > bB4
    bT4 := na
    bB4 := na
if not (bT4 == na) and not (bT6 == na) and bT6 < bT4 and bT6 > bB4
    bT4 := na
    bB4 := na
if not (bT5 == na) and not (bT1 == na) and bT1 < bT5 and bT1 > bB5
    bT5 := na
    bB5 := na
if not (bT5 == na) and not (bT2 == na) and bT2 < bT5 and bT2 > bB5
    bT5 := na
    bB5 := na
if not (bT5 == na) and not (bT3 == na) and bT3 < bT5 and bT3 > bB5
    bT5 := na
    bB5 := na
if not (bT5 == na) and not (bT4 == na) and bT4 < bT5 and bT4 > bB5
    bT5 := na
    bB5 := na
if not (bT5 == na) and not (bT6 == na) and bT6 < bT5 and bT6 > bB5
    bT5 := na
    bB5 := na
if not (bT6 == na) and not (bT1 == na) and bT1 < bT6 and bT1 > bB6
    bT6 := na
    bB6 := na
if not (bT6 == na) and not (bT2 == na) and bT2 < bT6 and bT2 > bB6
    bT6 := na
    bB6 := na
if not (bT6 == na) and not (bT3 == na) and bT3 < bT6 and bT3 > bB6
    bT6 := na
    bB6 := na
if not (bT6 == na) and not (bT4 == na) and bT4 < bT6 and bT4 > bB6
    bT6 := na
    bB6 := na
if not (bT6 == na) and not (bT5 == na) and bT5 < bT6 and bT5 > bB6
    bT6 := na
    bB6 := na
if not (sT1 == na) and not (sT2 == na) and sT2 < sT1 and sT2 > sB1
    sT1 := na
    sB1 := na
if not (sT1 == na) and not (sT3 == na) and sT3 < sT1 and sT3 > sB1
    sT1 := na
    sB1 := na
if not (sT1 == na) and not (sT4 == na) and sT4 < sT1 and sT4 > sB1
    sT1 := na
    sB1 := na
if not (sT1 == na) and not (sT5 == na) and sT5 < sT1 and sT5 > sB1
    sT1 := na
    sB1 := na
if not (sT1 == na) and not (sT6 == na) and sT6 < sT1 and sT6 > sB1
    sT1 := na
    sB1 := na
if not (sT2 == na) and not (sT1 == na) and sT1 < sT2 and sT1 > sB2
    sT2 := na
    sB2 := na
if not (sT2 == na) and not (sT3 == na) and sT3 < sT2 and sT3 > sB2
    sT2 := na
    sB2 := na
if not (sT2 == na) and not (sT4 == na) and sT4 < sT2 and sT4 > sB2
    sT2 := na
    sB2 := na
if not (sT2 == na) and not (sT5 == na) and sT5 < sT2 and sT5 > sB2
    sT2 := na
    sB2 := na
if not (sT2 == na) and not (sT6 == na) and sT6 < sT2 and sT6 > sB2
    sT2 := na
    sB2 := na
if not (sT3 == na) and not (sT1 == na) and sT1 < sT3 and sT1 > sB3
    sT3 := na
    sB3 := na
if not (sT3 == na) and not (sT2 == na) and sT2 < sT3 and sT2 > sB3
    sT3 := na
    sB3 := na
if not (sT3 == na) and not (sT4 == na) and sT4 < sT3 and sT4 > sB3
    sT3 := na
    sB3 := na
if not (sT3 == na) and not (sT5 == na) and sT5 < sT3 and sT5 > sB3
    sT3 := na
    sB3 := na
if not (sT3 == na) and not (sT6 == na) and sT6 < sT3 and sT6 > sB3
    sT3 := na
    sB3 := na
if not (sT4 == na) and not (sT1 == na) and sT1 < sT4 and sT1 > sB4
    sT4 := na
    sB4 := na
if not (sT4 == na) and not (sT2 == na) and sT2 < sT4 and sT2 > sB4
    sT4 := na
    sB4 := na
if not (sT4 == na) and not (sT3 == na) and sT3 < sT4 and sT3 > sB4
    sT4 := na
    sB4 := na
if not (sT4 == na) and not (sT5 == na) and sT5 < sT4 and sT5 > sB4
    sT4 := na
    sB4 := na
if not (sT4 == na) and not (sT6 == na) and sT6 < sT4 and sT6 > sB4
    sT4 := na
    sB4 := na
if not (sT5 == na) and not (sT1 == na) and sT1 < sT5 and sT1 > sB5
    sT5 := na
    sB5 := na
if not (sT5 == na) and not (sT2 == na) and sT2 < sT5 and sT2 > sB5
    sT5 := na
    sB5 := na
if not (sT5 == na) and not (sT3 == na) and sT3 < sT5 and sT3 > sB5
    sT5 := na
    sB5 := na
if not (sT5 == na) and not (sT4 == na) and sT4 < sT5 and sT4 > sB5
    sT5 := na
    sB5 := na
if not (sT5 == na) and not (sT6 == na) and sT6 < sT5 and sT6 > sB5
    sT5 := na
    sB5 := na
if not (sT6 == na) and not (sT1 == na) and sT1 < sT6 and sT1 > sB6
    sT6 := na
    sB6 := na
if not (sT6 == na) and not (sT2 == na) and sT2 < sT6 and sT2 > sB6
    sT6 := na
    sB6 := na
if not (sT6 == na) and not (sT3 == na) and sT3 < sT6 and sT3 > sB6
    sT6 := na
    sB6 := na
if not (sT6 == na) and not (sT4 == na) and sT4 < sT6 and sT4 > sB6
    sT6 := na
    sB6 := na
if not (sT6 == na) and not (sT5 == na) and sT5 < sT6 and sT5 > sB6
    sT6 := na
    sB6 := na

cLineB1 = bK1 ? color.rgb(120, 123, 134) : col_bull
cFillB1 = bK1 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB1T = plot(bT1, "Bull OB 1 Top", color=cLineB1, linewidth=1)
pB1B = plot(bB1, "Bull OB 1 Bottom", color=cLineB1, linewidth=1)
fill(pB1T, pB1B, cFillB1)
cLineB2 = bK2 ? color.rgb(120, 123, 134) : col_bull
cFillB2 = bK2 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB2T = plot(bT2, "Bull OB 2 Top", color=cLineB2, linewidth=1)
pB2B = plot(bB2, "Bull OB 2 Bottom", color=cLineB2, linewidth=1)
fill(pB2T, pB2B, cFillB2)
cLineB3 = bK3 ? color.rgb(120, 123, 134) : col_bull
cFillB3 = bK3 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB3T = plot(bT3, "Bull OB 3 Top", color=cLineB3, linewidth=1)
pB3B = plot(bB3, "Bull OB 3 Bottom", color=cLineB3, linewidth=1)
fill(pB3T, pB3B, cFillB3)
cLineB4 = bK4 ? color.rgb(120, 123, 134) : col_bull
cFillB4 = bK4 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB4T = plot(bT4, "Bull OB 4 Top", color=cLineB4, linewidth=1)
pB4B = plot(bB4, "Bull OB 4 Bottom", color=cLineB4, linewidth=1)
fill(pB4T, pB4B, cFillB4)
cLineB5 = bK5 ? color.rgb(120, 123, 134) : col_bull
cFillB5 = bK5 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB5T = plot(bT5, "Bull OB 5 Top", color=cLineB5, linewidth=1)
pB5B = plot(bB5, "Bull OB 5 Bottom", color=cLineB5, linewidth=1)
fill(pB5T, pB5B, cFillB5)
cLineB6 = bK6 ? color.rgb(120, 123, 134) : col_bull
cFillB6 = bK6 ? color.rgb(120, 123, 134, 85) : color.rgb(20, 190, 148, 70)
pB6T = plot(bT6, "Bull OB 6 Top", color=cLineB6, linewidth=1)
pB6B = plot(bB6, "Bull OB 6 Bottom", color=cLineB6, linewidth=1)
fill(pB6T, pB6B, cFillB6)
cLineS1 = sK1 ? color.rgb(120, 123, 134) : col_bear
cFillS1 = sK1 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS1T = plot(sT1, "Bear OB 1 Top", color=cLineS1, linewidth=1)
pS1B = plot(sB1, "Bear OB 1 Bottom", color=cLineS1, linewidth=1)
fill(pS1T, pS1B, cFillS1)
cLineS2 = sK2 ? color.rgb(120, 123, 134) : col_bear
cFillS2 = sK2 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS2T = plot(sT2, "Bear OB 2 Top", color=cLineS2, linewidth=1)
pS2B = plot(sB2, "Bear OB 2 Bottom", color=cLineS2, linewidth=1)
fill(pS2T, pS2B, cFillS2)
cLineS3 = sK3 ? color.rgb(120, 123, 134) : col_bear
cFillS3 = sK3 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS3T = plot(sT3, "Bear OB 3 Top", color=cLineS3, linewidth=1)
pS3B = plot(sB3, "Bear OB 3 Bottom", color=cLineS3, linewidth=1)
fill(pS3T, pS3B, cFillS3)
cLineS4 = sK4 ? color.rgb(120, 123, 134) : col_bear
cFillS4 = sK4 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS4T = plot(sT4, "Bear OB 4 Top", color=cLineS4, linewidth=1)
pS4B = plot(sB4, "Bear OB 4 Bottom", color=cLineS4, linewidth=1)
fill(pS4T, pS4B, cFillS4)
cLineS5 = sK5 ? color.rgb(120, 123, 134) : col_bear
cFillS5 = sK5 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS5T = plot(sT5, "Bear OB 5 Top", color=cLineS5, linewidth=1)
pS5B = plot(sB5, "Bear OB 5 Bottom", color=cLineS5, linewidth=1)
fill(pS5T, pS5B, cFillS5)
cLineS6 = sK6 ? color.rgb(120, 123, 134) : col_bear
cFillS6 = sK6 ? color.rgb(120, 123, 134, 85) : color.rgb(194, 25, 25, 70)
pS6T = plot(sT6, "Bear OB 6 Top", color=cLineS6, linewidth=1)
pS6B = plot(sB6, "Bear OB 6 Bottom", color=cLineS6, linewidth=1)
fill(pS6T, pS6B, cFillS6)

pGFBT = plot(show_imb and gAgeBull <= 5 ? gTopBull : na, "FVG Bull Top", color=color.new(color.gray, 60), linewidth=1)
pGFBB = plot(show_imb and gAgeBull <= 5 ? gBotBull : na, "FVG Bull Bottom", color=color.new(color.gray, 60), linewidth=1)
fill(pGFBT, pGFBB, color.new(color.gray, 85))
pGFST = plot(show_imb and gAgeBear <= 5 ? gTopBear : na, "FVG Bear Top", color=color.new(color.gray, 60), linewidth=1)
pGFSB = plot(show_imb and gAgeBear <= 5 ? gBotBear : na, "FVG Bear Bottom", color=color.new(color.gray, 60), linewidth=1)
fill(pGFST, pGFSB, color.new(color.gray, 85))

sigBull = show_signal and not isBull_gap and ((low > bT1 and low[1] <= bT1) or (low > bT2 and low[1] <= bT2) or (low > bT3 and low[1] <= bT3) or (low > bT4 and low[1] <= bT4) or (low > bT5 and low[1] <= bT5) or (low > bT6 and low[1] <= bT6))
plotshape(sigBull, "Sinyal Bull OB", style=shape.triangleup, location=location.belowbar, color=col_bull, size=size.small)
sigBear = show_signal and not isBear_gap and ((high < sB1 and high[1] >= sB1) or (high < sB2 and high[1] >= sB2) or (high < sB3 and high[1] >= sB3) or (high < sB4 and high[1] >= sB4) or (high < sB5 and high[1] >= sB5) or (high < sB6 and high[1] >= sB6))
plotshape(sigBear, "Sinyal Bear OB", style=shape.triangledown, location=location.abovebar, color=col_bear, size=size.small)
`;
