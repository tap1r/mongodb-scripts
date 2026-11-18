#!/usr/bin/env python3
"""Render the charts linked from Compressor analysis.md.

Reads compressor-analysis.json at the repository root and writes the PNGs
under compressor-analysis/. The root is the parent of this file's directory.

   python src/compressor-charts.py
   python src/compressor-charts.py combined levels
   python src/compressor-charts.py json [path]

Chart names are the carriers plus combined, levels, and manifold. With no
names, every chart is drawn. The json command reads the published file and
writes it again in the same 3-space layout. With no path it writes to stdout,
and a redirect is byte-for-byte the file. The published file has no trailing
newline.
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

CARRIERS = [
   ("int32", "int32"),
   ("double", "double"),
   ("long", "long"),
   ("date", "date"),
   ("decimal128", "decimal128"),
   ("string", "string"),
   ("binary", "binary")
]
PATTERNS = [
   (1, "Repetitive"),
   (5, "Mixed"),
   (10, "Nearly random")
]
PANEL = {1: 0, 5: 1, 10: 2}
SERIES = [
   ("zlib", 6, ZLIB, "zlib 6"),
   ("zstd", 3, ZSTD, "zstd 3"),
   ("snappy", None, SNAP, "snappy")
]
FIRST = {
   "int32": 32,
   "long": 64,
   "double": 64,
   "date": 64,
   "decimal128": 64,
   "string": 32,
   "binary": 32
}
DETAIL_TICKS = [1, 256, 4096, 65536, 1048576, 16777216]
CHARTS = [key for key, _title in CARRIERS] + ["combined", "levels", "manifold"]

# The strings are the article's rounded figures. Formatting wireRatio would move them.
End = namedtuple("End", "pattern comp level text color va dy")
Point = namedtuple("Point", "pattern comp level target text color dx dy")
Corner = namedtuple("Corner", "pattern x y text color ha va size")

NOTES = {
   "int32": [
      End(1, "zstd", 3, "32.4×", ZSTD, "top", -3),
      End(1, "zlib", 6, "5.2×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "2.7×", SNAP, "bottom", 3),
      End(5, "zstd", 3, "30.2×", ZSTD, "top", -3),
      End(10, "zstd", 3, "1.84×", ZSTD, "bottom", 4),
      Point(10, "zstd", 3, 512, "zlib and zstd\nabove from 512 B", ZSTD, 16, 18),
      Point(10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, -8, -22)
   ],
   "double": [
      End(1, "zstd", 3, "86.4×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Point(1, "zstd", 3, 64, "back below", ZSTD, 34, -14),
      Point(5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16),
      Point(10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, 12, -20)
   ],
   "long": [
      End(1, "zstd", 3, "74.2×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Point(1, "zstd", 3, 64, "back below", ZSTD, 34, -14),
      Point(5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16),
      Corner(1, 0.03, 0.90, "double finishes at 86.4×", MUTED, "left", "top", 8)
   ],
   "date": [
      End(1, "zstd", 3, "74.2×", ZSTD, "top", -3),
      End(1, "zlib", 6, "6.7×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "3.2×", SNAP, "bottom", 3),
      Corner(1, 0.03, 0.90, "tracks the long chart", MUTED, "left", "top", 8)
   ],
   "decimal128": [
      End(1, "zstd", 3, "60.3×", ZSTD, "top", -3),
      End(1, "zlib", 6, "9.1×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "4.8×", SNAP, "bottom", 3),
      Point(1, "snappy", None, 32, "1.55×", SNAP, 14, 12),
      Corner(10, 0.98, 0.90, "at 64 KiB: zstd 1.06×, zlib 1.12×\nsnappy above from 128 KiB", MUTED, "right", "top", 8)
   ],
   "string": [
      End(1, "zstd", 3, "28,728×", ZSTD, "top", -3),
      End(1, "zlib", 6, "1,026×", ZLIB, "bottom", 3),
      End(1, "snappy", None, "21.3×", SNAP, "bottom", 3),
      End(5, "zstd", 3, "10,376×", ZSTD, "top", -3),
      End(5, "snappy", None, "21×", SNAP, "bottom", 3),
      Corner(10, 0.98, 0.08, "snappy stays below the line\n+777 bytes at 16 MiB", SNAP, "right", "bottom", 8.5)
   ],
   "binary": [
      End(1, "zstd", 3, "28,728×", ZSTD, "top", -3),
      End(1, "snappy", None, "21.3×", SNAP, "bottom", 3),
      Corner(
         10, 0.98, 0.90,
         "below the line at every size\nat 16 MiB: zstd +406 · snappy +778 · zlib +2,660",
         MUTED, "right", "top", 8.5
      )
   ]
}

# compressor, anchor level, text, xytext, text color.
# The 16 MiB level 3 callout sits above the level 3–7 hump.
LEVEL_PANELS = [
   {
      "slice": "level64",
      "title": "64 KiB array of zero int32s",
      "xlim": (-2, 23),
      "target": 65536,
      "snappy": "snappy  2.2×",
      "callouts": [
         ("zstd", 3, "level 3  13.1×", (5.2, 22), ZSTD),
         ("zstd", 13, "level 13  7.7×", (15.4, 11.5), MUTED),
         ("zstd", 19, "levels 19–21  36.7×", (8.5, 39.5), MUTED),
         ("zlib", 3, "zlib 3  4.9×", (5.4, 8.6), ZLIB)
      ]
   },
   {
      "slice": "levelMax",
      "title": "16 MiB array of zero int32s",
      "xlim": (-3, 24),
      "target": 16777216,
      "snappy": "snappy  2.7×",
      "callouts": [
         ("zstd", 3, "level 3  32.4×", (4.2, 42.5), ZSTD),
         ("zstd", 12, "levels 8–15  ~21×", (13.2, 14.5), MUTED),
         ("zstd", 17, "level 17  44.8×", (8.2, 48.2), MUTED),
         ("zlib", 3, "zlib 3  6.2×", (5.2, 10.4), ZLIB)
      ]
   }
]

_GRID = None
_PLOT_READY = False

def grid():
   global _GRID
   if _GRID is None:
      with open(DATA) as f:
         _GRID = json.load(f)
   return _GRID

def rows():
   return grid()["rows"]

def emit_json(path):
   """Write the loaded grid in the published 3-space layout."""
   text = json.dumps(grid(), indent=3)
   if path is None:
      sys.stdout.write(text)
      if sys.stdout.isatty():
         sys.stdout.write("\n")
      return
   Path(path).write_text(text)

def plotting():
   global _PLOT_READY, plt, Line2D, FuncFormatter, NullFormatter, blended_transform_factory
   if _PLOT_READY:
      return
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
   _PLOT_READY = True

def pick(slice_, carrier, pattern, comp, level, target=None, *, every_level=False):
   hits = [
      r
      for r in rows()
      if r["slice"] == slice_
      and r["carrier"] == carrier
      and r["pattern"] == pattern
      and r["compressor"] == comp
      and (every_level or r["level"] == level)
      and (target is None or r["target"] == target)
   ]
   if target is not None and not every_level:
      if len(hits) != 1:
         raise SystemExit(f"expected 1 row, got {len(hits)} for {slice_} {carrier} pattern {pattern} {comp} {level} t={target}")
      return hits[0]
   hits.sort(key=lambda r: r["target"])
   if not hits:
      raise SystemExit(f"no rows for {slice_} {carrier} pattern {pattern} {comp} {level}")
   return hits

def level_rows(slice_name, compressor):
   hits = pick(slice_name, "int32", 1, compressor, None, every_level=True)
   hits.sort(key=lambda r: r["level"])
   return hits

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

def style_axis(ax, ticks):
   ax.set_xscale("log", base=2)
   ax.set_yscale("log")
   ax.set_xticks(ticks)
   ax.xaxis.set_major_formatter(FuncFormatter(size_label))
   ax.yaxis.set_major_formatter(FuncFormatter(ratio_label))
   ax.yaxis.set_minor_formatter(NullFormatter())
   ax.axhline(1, color=LINE, lw=1.0, ls=(0, (2, 2)), zorder=1)
   ax.grid(True, which="major", color=GRID, lw=0.8)
   ax.tick_params(length=0)
   ax.margins(x=0.02)

def plot_length(ax, carrier, pattern, ticks):
   ratios = []
   for comp, level, color, _label in SERIES:
      found = pick("length", carrier, pattern, comp, level)
      xs = [r["target"] for r in found]
      ys = [r["wireRatio"] for r in found]
      ratios.extend(ys)
      ax.plot(xs, ys, color=color, lw=2.15, solid_capstyle="round", zorder=3)
   style_axis(ax, ticks)
   bits = pick("length", carrier, pattern, "none", None, 65536)["bits"]
   return bits, min(ratios), max(ratios)

def length_handles():
   handles = [
      Line2D([0], [0], color=color, lw=2.4, label=label)
      for _c, _l, color, label in SERIES
   ]
   handles.append(Line2D([0], [0], color=LINE, lw=1.0, ls=(0, (2, 2)), label="ratio of 1"))
   return handles

def tag_end(ax, key, pattern, comp, level, text, color, va="top", dy=-3):
   row = pick("length", key, pattern, comp, level, 16777216)
   ax.annotate(
      text,
      xy=(row["target"], row["wireRatio"]),
      xytext=(-5, dy),
      textcoords="offset points",
      ha="right",
      va=va,
      fontsize=8,
      color=color
   )

def point_at(ax, key, pattern, comp, level, target, text, color, dx, dy):
   row = pick("length", key, pattern, comp, level, target)
   ax.annotate(
      text,
      xy=(row["target"], row["wireRatio"]),
      xytext=(dx, dy),
      textcoords="offset points",
      fontsize=8,
      color=color,
      arrowprops={"arrowstyle": "-", "color": color, "lw": 0.7}
   )

def mark_carrier(key, axes):
   for note in NOTES[key]:
      ax = axes[PANEL[note.pattern]]
      if isinstance(note, End):
         tag_end(ax, key, note.pattern, note.comp, note.level, note.text, note.color, va=note.va, dy=note.dy)
      elif isinstance(note, Point):
         point_at(ax, key, note.pattern, note.comp, note.level, note.target, note.text, note.color, note.dx, note.dy)
      else:
         ax.text(
            note.x, note.y, note.text,
            transform=ax.transAxes, ha=note.ha, va=note.va, fontsize=note.size, color=note.color
         )

def lasting_cross(carrier, pattern, comp, level):
   """First sampled target that is above the line and stays above."""
   last_below = None
   cross = None
   for row in pick("length", carrier, pattern, comp, level):
      if row["wireRatio"] < 1:
         last_below = row["target"]
         cross = None
      elif cross is None and last_below is not None and row["target"] > last_below:
         cross = row["target"]
   return cross

def crossing_groups(key, pattern):
   groups = {}
   for comp, level, color, _label in SERIES:
      target = lasting_cross(key, pattern, comp, level)
      if target is None:
         continue
      groups.setdefault(target, []).append(color)
   return sorted(groups.items())

def group_color(colors):
   return colors[0] if len(colors) == 1 else MUTED

def mark_tick(ax, target, color):
   ax.plot([target], [1], marker="|", markersize=9, mew=1.2, color=color, zorder=4)

def mark_top_row(ax, key, items):
   # The string scale crushes ratio 1, so the label sits in the open band with a stem.
   # String and binary rise through that band, so their label sits up and to the left.
   for i, (target, colors) in enumerate(items):
      close = i > 0 and target <= items[i - 1][0] * 4
      color = group_color(colors)
      mark_tick(ax, target, color)
      if key in ("string", "binary"):
         text_x, text_y = target / 2.6, 0.34
      else:
         text_x, text_y = target, 0.20 + (0.14 if close else 0)
      ax.annotate(
         size_label(target),
         xy=(target, 1),
         xycoords="data",
         xytext=(text_x, text_y),
         textcoords=blended_transform_factory(ax.transData, ax.transAxes),
         ha="right",
         va="bottom",
         fontsize=8,
         color=color,
         arrowprops={"arrowstyle": "-", "color": color, "lw": 0.6},
         zorder=5
      )

def mark_bottom_row(ax, items):
   # A label on the line sits on the curve that just crossed.
   # The later mark is snappy at 128 KiB; it sits under the line.
   # A lone mark, the string's 512, sits to the left of the rise.
   for i, (target, colors) in enumerate(items):
      color = group_color(colors)
      mark_tick(ax, target, color)
      if len(items) == 1:
         ha, va, offset = "right", "bottom", (-2, 6)
      elif i == 0:
         ha, va, offset = "right", "bottom", (0, 4)
      else:
         ha, va, offset = "left", "top", (3, -8)
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
   # The shared scale hides these two results. The paragraphs name them.
   for col, (key, _title) in enumerate(CARRIERS):
      mark_top_row(axes[0][col], key, crossing_groups(key, 1))
      mark_bottom_row(axes[1][col], crossing_groups(key, 10))
      if key == "string":
         axes[1][col].text(
            0.50, 0.78, "snappy below",
            transform=axes[1][col].transAxes, ha="center", va="center", fontsize=8, color=SNAP
         )
      if key == "binary":
         axes[1][col].text(
            0.50, 0.78, "below the line",
            transform=axes[1][col].transAxes, ha="center", va="center", fontsize=8, color=MUTED
         )

def carrier_chart(key, title):
   plotting()
   # The pale line is the first sampled target that holds a real document.
   first = FIRST[key]
   ticks = sorted(set(DETAIL_TICKS) | {first})
   fig, axes = plt.subplots(3, 1, figsize=(9.4, 8.6), sharex=True, constrained_layout=True)
   for ax, (pattern, name) in zip(axes, PATTERNS):
      bits, lo, hi = plot_length(ax, key, pattern, ticks)
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
   mark_carrier(key, axes)
   fig.legend(handles=length_handles(), loc="upper right", frameon=False, bbox_to_anchor=(0.995, 1.005), ncol=4, fontsize=10)
   fig.suptitle(title, fontsize=15, x=0.01, ha="left")
   OUT.mkdir(exist_ok=True)
   fig.savefig(OUT / f"{key}.png", dpi=160)
   plt.close(fig)

def combined_chart():
   plotting()
   ticks = [1, 65536, 16777216]
   fig, axes = plt.subplots(2, len(CARRIERS), figsize=(19.2, 6.6), sharex=True, constrained_layout=True)
   bounds = {1: [float("inf"), 0.0], 10: [float("inf"), 0.0]}
   for col, (key, title) in enumerate(CARRIERS):
      for row, (pattern, name) in enumerate(((1, "Repetitive"), (10, "Nearly random"))):
         ax = axes[row][col]
         _bits, lo, hi = plot_length(ax, key, pattern, ticks)
         bounds[pattern][0] = min(bounds[pattern][0], lo)
         bounds[pattern][1] = max(bounds[pattern][1], hi)
         if row == 0:
            ax.set_title(title, fontsize=12, pad=8)
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
   OUT.mkdir(exist_ok=True)
   fig.savefig(OUT / "combined.png", dpi=150, bbox_inches="tight")
   plt.close(fig)

def draw_levels(ax, zstd_rows, zlib_rows):
   ax.plot([r["level"] for r in zlib_rows], [r["wireRatio"] for r in zlib_rows], color=ZLIB, lw=1.8, zorder=3)
   ax.scatter([r["level"] for r in zlib_rows], [r["wireRatio"] for r in zlib_rows], color=ZLIB, s=18, zorder=4)
   ax.plot([r["level"] for r in zstd_rows], [r["wireRatio"] for r in zstd_rows], color=RUST, lw=2.15, zorder=3)
   ax.scatter([r["level"] for r in zstd_rows], [r["wireRatio"] for r in zstd_rows], color=RUST, s=22, zorder=4)
   default = next(r for r in zstd_rows if r["level"] == 3)
   ax.scatter([3], [default["wireRatio"]], s=78, color=ZSTD, zorder=5, edgecolor="white", linewidth=1.2)

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

def level_chart():
   plotting()
   fig, axes = plt.subplots(1, 2, figsize=(11.2, 5.35))
   fig.subplots_adjust(top=0.74, wspace=0.28, bottom=0.14, left=0.07, right=0.98)
   for ax, spec in zip(axes, LEVEL_PANELS):
      zstd_rows = level_rows(spec["slice"], "zstd")
      zlib_rows = level_rows(spec["slice"], "zlib")
      draw_levels(ax, zstd_rows, zlib_rows)
      found = {"zstd": zstd_rows, "zlib": zlib_rows}
      for comp, level, text, xytext, color in spec["callouts"]:
         row = next(r for r in found[comp] if r["level"] == level)
         ax.annotate(
            text,
            xy=(level, row["wireRatio"]),
            xytext=xytext,
            fontsize=9,
            color=color,
            arrowprops={"arrowstyle": "-", "color": color if color in (ZSTD, ZLIB) else ARROW, "lw": 0.8},
         )
      snappy = pick(spec["slice"], "int32", 1, "snappy", None, spec["target"])
      ax.axhline(snappy["wireRatio"], color=SNAP, lw=1.2, ls=(0, (3, 2)), zorder=2)
      ax.text(22, snappy["wireRatio"] + 0.8, spec["snappy"], color=SNAP, fontsize=9, ha="right")
      finish_level_panel(ax, spec["title"], spec["xlim"])
   handles = [
      Line2D([0], [0], color=ZSTD, marker="o", lw=0, ms=8, label="zstd 3, sent when left unset"),
      Line2D([0], [0], color=RUST, lw=2.4, marker="o", ms=5, label="other zstd levels, Rust API only"),
      Line2D([0], [0], color=ZLIB, lw=2.2, marker="o", ms=4, label="zlib, levels −1 to 9"),
      Line2D([0], [0], color=SNAP, lw=1.2, ls=(0, (3, 2)), label="snappy"),
   ]
   fig.legend(handles=handles, loc="upper center", frameon=False, ncol=2, fontsize=10, bbox_to_anchor=(0.5, 0.98))
   OUT.mkdir(exist_ok=True)
   fig.savefig(OUT / "levels.png", dpi=160)
   plt.close(fig)

def surface_rows(carrier, comp, level):
   # Patterns 1, 5, and 10 live on the length slice. The other seven are surface.
   found = []
   for pattern in range(1, 11):
      slice_ = "length" if pattern in (1, 5, 10) else "surface"
      found.extend(pick(slice_, carrier, pattern, comp, level))
   return found

def manifold_chart():
   plotting()
   import numpy as np

   fig = plt.figure(figsize=(17.2, 9.4))
   fig.subplots_adjust(left=0.02, right=0.97, top=0.90, bottom=0.04, wspace=0.16, hspace=0.28)
   for i, (key, title) in enumerate(CARRIERS):
      ax = fig.add_subplot(2, 4, i + 1, projection="3d")
      for comp, level, color, _label in SERIES:
         found = surface_rows(key, comp, level)
         patterns = sorted({r["pattern"] for r in found})
         sizes = sorted({r["target"] for r in found})
         by = {(r["pattern"], r["target"]): r["wireRatio"] for r in found}
         if len(by) != len(patterns) * len(sizes):
            raise SystemExit(f"surface holes for {key} {comp}: {len(by)} of {len(patterns) * len(sizes)}")
         x = np.log2(np.array(sizes, dtype=float))
         X, Y = np.meshgrid(x, patterns)
         Z = np.empty((len(patterns), len(sizes)))
         for yi, pattern in enumerate(patterns):
            for xi, size in enumerate(sizes):
               Z[yi, xi] = by[(pattern, size)]
         ax.plot_surface(X, Y, Z, color=color, alpha=0.55, linewidth=0, antialiased=True, shade=False)
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
      ax.set_title(title, fontsize=12, pad=-2)
      ax.tick_params(labelsize=7, pad=0)
      for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
         axis.pane.set_facecolor((1, 1, 1, 0))
         axis.pane.set_edgecolor("#e6e6e6")
   legend_ax = fig.add_subplot(2, 4, 8)
   legend_ax.axis("off")
   handles = [Line2D([0], [0], color=color, lw=2.4, label=label) for _c, _l, color, label in SERIES]
   legend_ax.legend(handles, [h.get_label() for h in handles], loc="center", frameon=False, fontsize=12)
   legend_ax.text(
      0.5, 0.18,
      "Each sheet is one compressor\nacross every pattern and every size.\nThe length charts are the\npattern 1, 5, and 10 slices.",
      transform=legend_ax.transAxes, ha="center", va="top", fontsize=10, color=MUTED
   )
   fig.suptitle("Wire ratio over document size and pattern", fontsize=15)
   OUT.mkdir(exist_ok=True)
   fig.savefig(OUT / "manifold.png", dpi=140)
   plt.close(fig)

def draw(names):
   plotting()
   titles = dict(CARRIERS)
   for name in names:
      if name in titles:
         carrier_chart(name, titles[name])
      elif name == "combined":
         combined_chart()
      elif name == "levels":
         level_chart()
      elif name == "manifold":
         manifold_chart()
      print("wrote", name, flush=True)

def main(argv):
   if argv and argv[0] == "json":
      if len(argv) > 2:
         raise SystemExit("usage: compressor-charts.py json [path]")
      emit_json(argv[1] if len(argv) == 2 else None)
      return
   unknown = [name for name in argv if name not in CHARTS]
   if unknown:
      raise SystemExit("unknown chart: " + ", ".join(unknown) + "\ncharts: " + ", ".join(CHARTS))
   draw(argv or CHARTS)


if __name__ == "__main__":
   main(sys.argv[1:])
