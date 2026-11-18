#!/usr/bin/env python3
"""Render the charts linked from Compressor analysis.md.

Reads compressor-analysis.json at the repository root and writes the PNGs
under compressor-analysis/. The root is the parent of this file's directory.

   python src/compressor-charts.py
   python src/compressor-charts.py combined levels
   python src/compressor-charts.py check
   python src/compressor-charts.py json [path]

Chart names are the carriers plus combined, levels, and manifold. With no
names, every chart is drawn. check compares the lasting crossings to the
published marks and does not draw. The json command reads the published file
and writes it again in the same 3-space layout. With no path it writes to
stdout, and a redirect is byte-for-byte the file. The published file has no
trailing newline.
"""

import json
import sys
from collections import namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "compressor-analysis.json"
OUT = ROOT / "compressor-analysis"

ZLIB = "#0072B2"
ZSTD = "#D55E00"
RUST = "#CC79A7"
SNAP = "#009E73"
GRID = "#E6E6E6"
INK = "#1c1c1c"
MUTED = "#5c5c5c"
LINE = "#9a9a9a"
ARROW = "#b0b0b0"

End = namedtuple("End", "pattern comp level text color va dy")
Point = namedtuple("Point", "pattern comp level target text color dx dy")
Corner = namedtuple("Corner", "pattern x y text color ha va size")
Caption = namedtuple("Caption", "text color")
Carrier = namedtuple("Carrier", "name first notes place caption")
Series = namedtuple("Series", "comp level color label")
Callout = namedtuple("Callout", "comp level text xytext color mark")
Cross = namedtuple("Cross", "comp color target")
LevelPanel = namedtuple("LevelPanel", "slice carrier pattern title xlim target snappy callouts")
Plot = namedtuple("Plot", "plt Line2D FuncFormatter NullFormatter blended_transform_factory")

# The strings are the article's rounded figures. Formatting wireRatio would move them.
# place is "band" or "tick". caption is the bottom-row note the shared scale hides.
CARRIERS = [
   Carrier("int32", 32, [
      End(1, "zstd", 3, "32.4×", ZSTD, "top", -3),
      End(1, "zlib", 6, "5.2×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "2.7×", SNAP, "bottom", 3),
      End(5, "zstd", 3, "30.2×", ZSTD, "top", -3),
      End(10, "zstd", 3, "1.84×", ZSTD, "bottom", 4),
      Point(10, "zstd", 3, 512, "zlib and zstd\nabove from 512 B", ZSTD, 16, 18),
      Point(10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, -8, -22)
   ], "tick", None),
   Carrier("double", 64, [
      End(1, "zstd", 3, "86.4×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Point(1, "zstd", 3, 64, "back below", ZSTD, 34, -14),
      Point(5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16),
      Point(10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, 12, -20)
   ], "tick", None),
   Carrier("long", 64, [
      End(1, "zstd", 3, "74.2×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Point(1, "zstd", 3, 64, "back below", ZSTD, 34, -14),
      Point(5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16),
      Corner(1, 0.03, 0.90, "double finishes at 86.4×", MUTED, "left", "top", 8)
   ], "tick", None),
   Carrier("date", 64, [
      End(1, "zstd", 3, "74.2×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Corner(1, 0.03, 0.90, "tracks the long chart", MUTED, "left", "top", 8)
   ], "tick", None),
   Carrier("decimal128", 64, [
      End(1, "zstd", 3, "60.3×", ZSTD, "top", -3),
      End(1, "zlib", 6, "9.1×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "4.8×", SNAP, "bottom", 3),
      Point(1, "snappy", None, 32, "1.55×", SNAP, 14, 12),
      Corner(10, 0.98, 0.90, "at 64 KiB: zstd 1.06×, zlib 1.12×\nsnappy above from 128 KiB", MUTED, "right", "top", 8)
   ], "tick", None),
   Carrier("string", 32, [
      End(1, "zstd", 3, "28,728×", ZSTD, "top", -3),
      End(1, "zlib", 6, "1,026×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "21.3×", SNAP, "bottom", 3),
      End(5, "zstd", 3, "10,376×", ZSTD, "top", -3),
      End(5, "snappy", None, "21×", SNAP, "bottom", 3),
      Corner(10, 0.98, 0.08, "snappy stays below the line\n+777 bytes at 16 MiB", SNAP, "right", "bottom", 8.5)
   ], "band", Caption("snappy below", SNAP)),
   Carrier("binary", 32, [
      End(1, "zstd", 3, "28,728×", ZSTD, "top", -3),
      End(1, "snappy", None, "21.3×", SNAP, "bottom", 3),
      Corner(
         10, 0.98, 0.90,
         "below the line at every size\nat 16 MiB: zstd +406 · snappy +778 · zlib +2,660",
         MUTED, "right", "top", 8.5
      )
   ], "band", Caption("below the line", MUTED))
]

PATTERNS = [
   (1, "Repetitive"),
   (5, "Mixed"),
   (10, "Nearly random")
]
PANEL = {1: 0, 5: 1, 10: 2}
SERIES = [
   Series("zlib", 6, ZLIB, "zlib 6"),
   Series("zstd", 3, ZSTD, "zstd 3"),
   Series("snappy", None, SNAP, "snappy")
]
KIB_64 = 65536
BSON_MAX = 16777216
DETAIL_TICKS = [1, 256, 4096, KIB_64, 1048576, BSON_MAX]
CHARTS = [carrier.name for carrier in CARRIERS] + ["combined", "levels", "manifold"]

# First sampled target that stays above the line. Absent means the curve never does.
# Pattern 1 zstd on double, long, and date is 128, after the notch back below the line.
MARKS = {
   ("int32", 1): {"zlib": 64, "zstd": 128, "snappy": 128},
   ("double", 1): {"zlib": 32, "zstd": 128, "snappy": 32},
   ("long", 1): {"zlib": 32, "zstd": 128, "snappy": 32},
   ("date", 1): {"zlib": 32, "zstd": 128, "snappy": 32},
   ("decimal128", 1): {"zlib": 32, "zstd": 32, "snappy": 32},
   ("string", 1): {"zlib": 64, "zstd": 64, "snappy": 64},
   ("binary", 1): {"zlib": 64, "zstd": 64, "snappy": 64},
   ("int32", 10): {"zlib": 512, "zstd": 512, "snappy": 131072},
   ("double", 10): {"zlib": 1024, "zstd": 1024, "snappy": 131072},
   ("long", 10): {"zlib": 1024, "zstd": 1024, "snappy": 131072},
   ("date", 10): {"zlib": 1024, "zstd": 1024, "snappy": 131072},
   ("decimal128", 10): {"zlib": 2048, "zstd": 2048, "snappy": 131072},
   ("string", 10): {"zlib": 512, "zstd": 512},
   ("binary", 10): {}
}

# Both panels are the zero int32, pattern 1. The query lives on the panel.
# The 16 MiB level 3 callout sits above the level 3–7 hump.
LEVEL_PANELS = [
   LevelPanel(
      "level64", "int32", 1, "64 KiB array of zero int32s",
      (-2, 23), KIB_64, "snappy  2.2×",
      [
         Callout("zstd", 3, "level 3  13.1×", (5.2, 22), ZSTD, True),
         Callout("zstd", 13, "level 13  7.7×", (15.4, 11.5), MUTED, False),
         Callout("zstd", 19, "levels 19–21  36.7×", (8.5, 39.5), MUTED, False),
         Callout("zlib", 3, "zlib 3  4.9×", (5.4, 8.6), ZLIB, False)
      ]
   ),
   LevelPanel(
      "levelMax", "int32", 1, "16 MiB array of zero int32s",
      (-3, 24), BSON_MAX, "snappy  2.7×",
      [
         Callout("zstd", 3, "level 3  32.4×", (4.2, 42.5), ZSTD, True),
         Callout("zstd", 12, "levels 8–15  ~21×", (13.2, 14.5), MUTED, False),
         Callout("zstd", 17, "level 17  44.8×", (8.2, 48.2), MUTED, False),
         Callout("zlib", 3, "zlib 3  6.2×", (5.2, 10.4), ZLIB, False)
      ]
   )
]

_GRID = None
_INDEX = None
_BY_LEVEL = None
_PLOT = None


def grid():
   global _GRID
   if _GRID is None:
      with open(DATA) as f:
         _GRID = json.load(f)
   return _GRID

def rows():
   return grid()["rows"]

def indexes():
   """Curve rows sorted by target, and level rows sorted by level then target."""
   global _INDEX, _BY_LEVEL
   if _INDEX is None:
      grouped = {}
      by_level = {}
      for record in rows():
         key = (record["slice"], record["carrier"], record["pattern"], record["compressor"], record["level"])
         grouped.setdefault(key, []).append(record)
         parent = (record["slice"], record["carrier"], record["pattern"], record["compressor"])
         by_level.setdefault(parent, []).append(record)
      for hits in grouped.values():
         hits.sort(key=lambda record: record["target"])
      for hits in by_level.values():
         hits.sort(key=lambda record: (record["level"], record["target"]))
      _INDEX = grouped
      _BY_LEVEL = by_level
   return _INDEX, _BY_LEVEL

def curve(slice_, carrier, pattern, comp, level):
   grouped, _by_level = indexes()
   hits = grouped.get((slice_, carrier, pattern, comp, level))
   if not hits:
      raise SystemExit(f"no rows for {slice_} {carrier} pattern {pattern} {comp} {level}")
   return hits

def row(slice_, carrier, pattern, comp, level, target):
   hits = [record for record in curve(slice_, carrier, pattern, comp, level) if record["target"] == target]
   if len(hits) != 1:
      raise SystemExit(f"expected 1 row, got {len(hits)} for {slice_} {carrier} pattern {pattern} {comp} {level} t={target}")
   return hits[0]

def levels(slice_, carrier, pattern, comp):
   _grouped, by_level = indexes()
   hits = by_level.get((slice_, carrier, pattern, comp))
   if not hits:
      raise SystemExit(f"no level rows for {slice_} {carrier} pattern {pattern} {comp}")
   return hits

def sheet(carrier, comp, level):
   """Patterns, sizes, and wire ratios for one manifold sheet.
   PATTERNS (1, 5, and 10) come from the length slice. The other seven come from surface.
   """
   length = {pattern for pattern, _name in PATTERNS}
   found = []
   for pattern in range(1, 11):
      slice_ = "length" if pattern in length else "surface"
      found.extend(curve(slice_, carrier, pattern, comp, level))
   patterns = sorted({record["pattern"] for record in found})
   sizes = sorted({record["target"] for record in found})
   by = {(record["pattern"], record["target"]): record["wireRatio"] for record in found}
   if len(by) != len(patterns) * len(sizes):
      raise SystemExit(f"surface holes for {carrier} {comp}: {len(by)} of {len(patterns) * len(sizes)}")
   ratios = [[by[(pattern, size)] for size in sizes] for pattern in patterns]
   return patterns, sizes, ratios

def emit_json(path):
   """Write the loaded grid in the published 3-space layout."""
   text = json.dumps(grid(), indent=3)
   if path is None:
      sys.stdout.write(text)
      if sys.stdout.isatty():
         sys.stdout.write("\n")
      return
   Path(path).write_text(text)

def size_label(v, _pos=None):
   v = int(round(v))
   if v >= 1048576 and v % 1048576 == 0:
      n = v // 1048576
      return f"{n} MiB" if n > 1 else "1 MiB"
   if v >= 1024 and v % 1024 == 0:
      n = v // 1024
      return f"{n} KiB" if n > 1 else "1 KiB"
   return str(v)

def ratio_label(v, _pos=None):
   if v >= 1000:
      return f"{v:,.0f}"
   if v >= 10:
      return f"{v:.0f}"
   if v >= 1:
      return f"{v:.0f}" if abs(v - round(v)) < 1e-9 else f"{v:.1f}"
   return f"{v:.1f}" if v >= 0.1 else f"{v:.2f}"

def lasting_cross(found):
   """First sampled target that is above the line and stays above."""
   last_below = None
   cross = None
   for record in found:
      if record["wireRatio"] < 1:
         last_below = record["target"]
         cross = None
      elif cross is None and last_below is not None and record["target"] > last_below:
         cross = record["target"]
   return cross

def crossings(carrier, pattern):
   """One Cross per series. The target is None when the curve stays below the line."""
   found = []
   for series in SERIES:
      target = lasting_cross(curve("length", carrier, pattern, series.comp, series.level))
      found.append(Cross(series.comp, series.color, target))
   return found

def check_crossings():
   bad = []
   for carrier in CARRIERS:
      for pattern in (1, 10):
         got = {hit.comp: hit.target for hit in crossings(carrier.name, pattern) if hit.target is not None}
         want = MARKS[(carrier.name, pattern)]
         if got != want:
            bad.append(f"{carrier.name} pattern {pattern}: {got} != {want}")
   if bad:
      raise SystemExit("crossing marks moved:\n" + "\n".join(bad))

def crossing_groups(carrier, pattern):
   groups = {}
   for hit in crossings(carrier, pattern):
      if hit.target is None:
         continue
      groups.setdefault(hit.target, []).append(hit.color)
   return sorted(groups.items())

def group_color(colors):
   return colors[0] if len(colors) == 1 else MUTED

def plotting():
   """Load matplotlib once and keep its names on one holder."""
   global _PLOT
   if _PLOT is not None:
      return _PLOT
   import matplotlib
   matplotlib.use("Agg")
   import matplotlib.pyplot as plt
   from matplotlib.lines import Line2D
   from matplotlib.ticker import FuncFormatter, NullFormatter
   from matplotlib.transforms import blended_transform_factory
   plt.rcParams.update(
      {
         "font.family": "sans-serif",
         "font.size": 11,
         "text.color": INK,
         "axes.labelcolor": INK,
         "axes.edgecolor": "#bdbdbd",
         "axes.linewidth": 0.8,
         "xtick.color": MUTED,
         "ytick.color": MUTED,
         "axes.spines.top": False,
         "axes.spines.right": False,
         "figure.facecolor": "white",
         "axes.facecolor": "white",
         "savefig.facecolor": "white",
         "axes.axisbelow": True
      }
   )
   _PLOT = Plot(plt, Line2D, FuncFormatter, NullFormatter, blended_transform_factory)
   return _PLOT

def style_axis(ax, ticks):
   plot = plotting()
   ax.set_xscale("log", base=2)
   ax.set_yscale("log")
   ax.set_xticks(ticks)
   ax.xaxis.set_major_formatter(plot.FuncFormatter(size_label))
   ax.yaxis.set_major_formatter(plot.FuncFormatter(ratio_label))
   ax.yaxis.set_minor_formatter(plot.NullFormatter())
   ax.axhline(1, color=LINE, lw=1.0, ls=(0, (2, 2)), zorder=1)
   ax.grid(True, which="major", color=GRID, lw=0.8)
   ax.tick_params(length=0)
   ax.margins(x=0.02)

def plot_length(ax, carrier, pattern, ticks):
   ratios = []
   for series in SERIES:
      found = curve("length", carrier, pattern, series.comp, series.level)
      xs = [record["target"] for record in found]
      ys = [record["wireRatio"] for record in found]
      ratios.extend(ys)
      ax.plot(xs, ys, color=series.color, lw=2.15, solid_capstyle="round", zorder=3)
   style_axis(ax, ticks)
   bits = row("length", carrier, pattern, "none", None, KIB_64)["bits"]
   return bits, min(ratios), max(ratios)

def length_handles():
   plot = plotting()
   handles = [
      plot.Line2D([0], [0], color=series.color, lw=2.4, label=series.label)
      for series in SERIES
   ]
   handles.append(plot.Line2D([0], [0], color=LINE, lw=1.0, ls=(0, (2, 2)), label="ratio of 1"))
   return handles

def tag_end(ax, key, pattern, comp, level, text, color, va="top", dy=-3):
   found = row("length", key, pattern, comp, level, BSON_MAX)
   ax.annotate(
      text,
      xy=(found["target"], found["wireRatio"]),
      xytext=(-5, dy),
      textcoords="offset points",
      ha="right",
      va=va,
      fontsize=8,
      color=color
   )

def point_at(ax, key, pattern, comp, level, target, text, color, dx, dy):
   found = row("length", key, pattern, comp, level, target)
   ax.annotate(
      text,
      xy=(found["target"], found["wireRatio"]),
      xytext=(dx, dy),
      textcoords="offset points",
      fontsize=8,
      color=color,
      arrowprops={"arrowstyle": "-", "color": color, "lw": 0.7}
   )

def mark_carrier(carrier, axes):
   for note in carrier.notes:
      ax = axes[PANEL[note.pattern]]
      if isinstance(note, End):
         tag_end(ax, carrier.name, note.pattern, note.comp, note.level, note.text, note.color, va=note.va, dy=note.dy)
      elif isinstance(note, Point):
         point_at(ax, carrier.name, note.pattern, note.comp, note.level, note.target, note.text, note.color, note.dx, note.dy)
      elif isinstance(note, Corner):
         ax.text(
            note.x, note.y, note.text,
            transform=ax.transAxes, ha=note.ha, va=note.va, fontsize=note.size, color=note.color
         )
      else:
         raise SystemExit(f"unknown note on {carrier.name}: {note!r}")

def mark_tick(ax, target, color):
   ax.plot([target], [1], marker="|", markersize=9, mew=1.2, color=color, zorder=4)

# The string scale crushes ratio 1, so a top-row label sits in the open band.
# A band placement sits up and to the left, because those curves rise through the band.
TOP_STRING_X = 2.6
TOP_STRING_Y = 0.34
TOP_Y = 0.20
TOP_CLOSE_Y = 0.14
TOP_CLOSE = 4
# Snappy's own mark sits under the line. A single shared mark, the string's 512,
# sits to the left of the rise. The earlier shared mark stays just above the line.
SNAP_OFFSET = (3, -8)
LONE_OFFSET = (-2, 6)
EARLY_OFFSET = (0, 4)

def mark_top_row(ax, place, items):
   if place not in ("band", "tick"):
      raise SystemExit(f"unknown placement {place}")
   plot = plotting()
   for i, (target, colors) in enumerate(items):
      close = i > 0 and target <= items[i - 1][0] * TOP_CLOSE
      color = group_color(colors)
      mark_tick(ax, target, color)
      if place == "band":
         text_x, text_y = target / TOP_STRING_X, TOP_STRING_Y
      else:
         text_x, text_y = target, TOP_Y + (TOP_CLOSE_Y if close else 0)
      ax.annotate(
         size_label(target),
         xy=(target, 1),
         xycoords="data",
         xytext=(text_x, text_y),
         textcoords=plot.blended_transform_factory(ax.transData, ax.transAxes),
         ha="right",
         va="bottom",
         fontsize=8,
         color=color,
         arrowprops={"arrowstyle": "-", "color": color, "lw": 0.6},
         zorder=5
      )

def mark_bottom_row(ax, items):
   for target, colors in items:
      color = group_color(colors)
      mark_tick(ax, target, color)
      if colors == [SNAP]:
         ha, va, offset = "left", "top", SNAP_OFFSET
      elif len(items) == 1:
         ha, va, offset = "right", "bottom", LONE_OFFSET
      else:
         ha, va, offset = "right", "bottom", EARLY_OFFSET
      ax.annotate(
         size_label(target),
         xy=(target, 1),
         xytext=offset,
         textcoords="offset points",
         ha=ha,
         va=va,
         fontsize=8,
         color=color,
         zorder=5
      )

def mark_combined(axes):
   # The shared scale hides a caption. The paragraphs name the result.
   for col, carrier in enumerate(CARRIERS):
      mark_top_row(axes[0][col], carrier.place, crossing_groups(carrier.name, 1))
      mark_bottom_row(axes[1][col], crossing_groups(carrier.name, 10))
      if carrier.caption is not None:
         axes[1][col].text(
            0.50, 0.78, carrier.caption.text,
            transform=axes[1][col].transAxes, ha="center", va="center", fontsize=8, color=carrier.caption.color
         )

def save(fig, name, dpi, out, tight=False):
   out.mkdir(exist_ok=True)
   if tight:
      fig.savefig(out / name, dpi=dpi, bbox_inches="tight")
   else:
      fig.savefig(out / name, dpi=dpi)
   plotting().plt.close(fig)

def carrier_chart(carrier, out):
   plot = plotting()
   # The pale line is the first sampled target that holds a real document.
   first = carrier.first
   ticks = sorted(set(DETAIL_TICKS) | {first})
   fig, axes = plot.plt.subplots(3, 1, figsize=(9.4, 8.6), sharex=True, constrained_layout=True)
   for ax, (pattern, name) in zip(axes, PATTERNS):
      bits, lo, hi = plot_length(ax, carrier.name, pattern, ticks)
      ax.set_ylim(lo / 1.45, hi * 1.55)
      ax.set_ylabel("Wire ratio")
      ax.set_title(f"{name}  ·  pattern {pattern}  ·  {bits:.3f} bits/byte at 64 KiB", loc="left", fontsize=11, color=INK, pad=8)
   axes[-1].set_xlabel("Document target")
   for ax in axes:
      ax.axvline(first, color="#d0d0d0", lw=1.0, zorder=0)
   axes[0].annotate(
      "first\ndocument",
      xy=(first, axes[0].get_ylim()[1]),
      xytext=(6, -8),
      textcoords="offset points",
      ha="left",
      va="top",
      fontsize=8,
      color="#8a8a8a"
   )
   mark_carrier(carrier, axes)
   fig.legend(handles=length_handles(), loc="upper right", frameon=False, bbox_to_anchor=(0.995, 1.005), ncol=4, fontsize=10)
   fig.suptitle(carrier.name, fontsize=15, x=0.01, ha="left")
   save(fig, f"{carrier.name}.png", 160, out)

def combined_chart(out):
   plot = plotting()
   ticks = [1, KIB_64, BSON_MAX]
   fig, axes = plot.plt.subplots(2, len(CARRIERS), figsize=(19.2, 6.6), sharex=True, constrained_layout=True)
   bounds = {1: [float("inf"), 0.0], 10: [float("inf"), 0.0]}
   for col, carrier in enumerate(CARRIERS):
      for row, (pattern, name) in enumerate(((1, "Repetitive"), (10, "Nearly random"))):
         ax = axes[row][col]
         _bits, lo, hi = plot_length(ax, carrier.name, pattern, ticks)
         bounds[pattern][0] = min(bounds[pattern][0], lo)
         bounds[pattern][1] = max(bounds[pattern][1], hi)
         if row == 0:
            ax.set_title(carrier.name, fontsize=12, pad=8)
         if col == 0:
            ax.set_ylabel(f"{name}\nwire ratio")
         if row == 1:
            ax.set_xlabel("Target")
         ax.tick_params(labelsize=8)
   for pattern, row in ((1, 0), (10, 1)):
      lo, hi = bounds[pattern]
      for ax in axes[row]:
         ax.set_ylim(lo / 1.5, hi * 1.45)
   mark_combined(axes)
   fig.legend(handles=length_handles(), loc="upper center", frameon=False, bbox_to_anchor=(0.5, 1.06), ncol=4, fontsize=11)
   fig.suptitle("All seven carriers, on one scale per row", fontsize=15, y=1.10)
   save(fig, "combined.png", 150, out, tight=True)

def draw_levels(ax, zstd_rows, zlib_rows, marked):
   ax.plot([record["level"] for record in zlib_rows], [record["wireRatio"] for record in zlib_rows], color=ZLIB, lw=1.8, zorder=3)
   ax.scatter([record["level"] for record in zlib_rows], [record["wireRatio"] for record in zlib_rows], color=ZLIB, s=18, zorder=4)
   ax.plot([record["level"] for record in zstd_rows], [record["wireRatio"] for record in zstd_rows], color=RUST, lw=2.15, zorder=3)
   ax.scatter([record["level"] for record in zstd_rows], [record["wireRatio"] for record in zstd_rows], color=RUST, s=22, zorder=4)
   rows_for = {"zstd": zstd_rows, "zlib": zlib_rows}[marked.comp]
   default = next(record for record in rows_for if record["level"] == marked.level)
   ax.scatter([marked.level], [default["wireRatio"]], s=78, color=marked.color, zorder=5, edgecolor="white", linewidth=1.2)

def finish_level_panel(ax, title, xlim):
   ax.set_xlim(*xlim)
   ax.set_ylim(0, 52)
   ax.set_yticks([0, 10, 20, 30, 40, 50])
   ax.set_xlabel("level")
   ax.set_ylabel("Wire ratio")
   ax.set_title(title, loc="left", fontsize=12)
   ax.grid(True, axis="y", color=GRID, lw=0.8)
   ax.tick_params(length=0)
   ax.spines["top"].set_visible(False)
   ax.spines["right"].set_visible(False)

def level_chart(out):
   plot = plotting()
   fig, axes = plot.plt.subplots(1, 2, figsize=(11.2, 5.35))
   fig.subplots_adjust(top=0.74, wspace=0.28, bottom=0.14, left=0.07, right=0.98)
   for ax, panel in zip(axes, LEVEL_PANELS):
      zstd_rows = levels(panel.slice, panel.carrier, panel.pattern, "zstd")
      zlib_rows = levels(panel.slice, panel.carrier, panel.pattern, "zlib")
      marked = [callout for callout in panel.callouts if callout.mark]
      if len(marked) != 1:
         raise SystemExit(f"expected one marked level on {panel.slice}")
      draw_levels(ax, zstd_rows, zlib_rows, marked[0])
      found = {"zstd": zstd_rows, "zlib": zlib_rows}
      for callout in panel.callouts:
         record = next(item for item in found[callout.comp] if item["level"] == callout.level)
         ax.annotate(
            callout.text,
            xy=(callout.level, record["wireRatio"]),
            xytext=callout.xytext,
            fontsize=9,
            color=callout.color,
            arrowprops={"arrowstyle": "-", "color": callout.color if callout.color in (ZSTD, ZLIB) else ARROW, "lw": 0.8}
         )
      snappy = row(panel.slice, panel.carrier, panel.pattern, "snappy", None, panel.target)
      ax.axhline(snappy["wireRatio"], color=SNAP, lw=1.2, ls=(0, (3, 2)), zorder=2)
      ax.text(22, snappy["wireRatio"] + 0.8, panel.snappy, color=SNAP, fontsize=9, ha="right")
      finish_level_panel(ax, panel.title, panel.xlim)
   handles = [
      plot.Line2D([0], [0], color=ZSTD, marker="o", lw=0, ms=8, label="zstd 3, sent when left unset"),
      plot.Line2D([0], [0], color=RUST, lw=2.4, marker="o", ms=5, label="other zstd levels, Rust API only"),
      plot.Line2D([0], [0], color=ZLIB, lw=2.2, marker="o", ms=4, label="zlib, levels −1 to 9"),
      plot.Line2D([0], [0], color=SNAP, lw=1.2, ls=(0, (3, 2)), label="snappy")
   ]
   fig.legend(handles=handles, loc="upper center", frameon=False, ncol=2, fontsize=10, bbox_to_anchor=(0.5, 0.98))
   save(fig, "levels.png", 160, out)

def manifold_chart(out):
   plot = plotting()
   import numpy as np

   fig = plot.plt.figure(figsize=(17.2, 9.4))
   fig.subplots_adjust(left=0.02, right=0.97, top=0.90, bottom=0.04, wspace=0.16, hspace=0.28)
   for i, carrier in enumerate(CARRIERS):
      ax = fig.add_subplot(2, 4, i + 1, projection="3d")
      for series in SERIES:
         patterns, sizes, ratios = sheet(carrier.name, series.comp, series.level)
         x = np.log2(np.array(sizes, dtype=float))
         X, Y = np.meshgrid(x, patterns)
         Z = np.array(ratios, dtype=float)
         ax.plot_surface(X, Y, Z, color=series.color, alpha=0.55, linewidth=0, antialiased=True, shade=False)
      ax.set_zscale("log")
      ax.set_xticks([0, 8, 16, 24])
      ax.set_xticklabels(["1", "256", "64 KiB", "16 MiB"], fontsize=7)
      ax.set_yticks([1, 3, 5, 7, 10])
      ax.set_xlabel("Size", fontsize=8, labelpad=1)
      ax.set_ylabel("Pattern", fontsize=8, labelpad=1)
      # The top-right panel sits against the figure edge. Its z label was clipped.
      if i % 4 != 3:
         ax.set_zlabel("Ratio", fontsize=8, labelpad=0)
      ax.view_init(elev=26, azim=-58)
      ax.set_title(carrier.name, fontsize=12, pad=-2)
      ax.tick_params(labelsize=7, pad=0)
      for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
         axis.pane.set_facecolor((1, 1, 1, 0))
         axis.pane.set_edgecolor("#e6e6e6")
   legend_ax = fig.add_subplot(2, 4, 8)
   legend_ax.axis("off")
   handles = [plot.Line2D([0], [0], color=series.color, lw=2.4, label=series.label) for series in SERIES]
   legend_ax.legend(handles, [h.get_label() for h in handles], loc="center", frameon=False, fontsize=12)
   legend_ax.text(
      0.5, 0.18,
      "Each sheet is one compressor\nacross every pattern and every size.\nThe length charts are the\npattern 1, 5, and 10 slices.",
      transform=legend_ax.transAxes, ha="center", va="top", fontsize=10, color=MUTED
   )
   fig.suptitle("Wire ratio over document size and pattern", fontsize=15)
   save(fig, "manifold.png", 140, out)

def draw(names, out=None):
   """Draw the named charts into out, or into compressor-analysis/ when out is omitted."""
   check_crossings()
   plotting()
   dest = OUT if out is None else Path(out)
   by_name = {carrier.name: carrier for carrier in CARRIERS}
   for name in names:
      if name in by_name:
         carrier_chart(by_name[name], dest)
      elif name == "combined":
         combined_chart(dest)
      elif name == "levels":
         level_chart(dest)
      elif name == "manifold":
         manifold_chart(dest)
      print("wrote", name, flush=True)

def main(argv):
   if argv and argv[0] == "json":
      if len(argv) > 2:
         raise SystemExit("usage: compressor-charts.py json [path]")
      emit_json(argv[1] if len(argv) == 2 else None)
      return
   if argv == ["check"]:
      check_crossings()
      print("crossings match")
      return
   unknown = [name for name in argv if name not in CHARTS]
   if unknown:
      raise SystemExit("unknown chart: " + ", ".join(unknown) + "\ncharts: " + ", ".join(CHARTS))
   draw(argv or CHARTS)


if __name__ == "__main__":
   main(sys.argv[1:])
