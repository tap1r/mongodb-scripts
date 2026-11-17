#!/usr/bin/env python3
"""Render the charts linked from Compressor analysis.md.

Reads compressor-analysis.json at the repository root and writes the PNGs
under compressor-analysis/. The root is the parent of this file's directory.
"""

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "compressor-analysis"
OUT.mkdir(exist_ok=True)

with open(ROOT / "compressor-analysis.json") as f:
    ROWS = json.load(f)["rows"]

ZLIB = "#0072B2"
ZSTD = "#D55E00"
RUST = "#CC79A7"
SNAP = "#009E73"
GRID = "#E6E6E6"
INK = "#1c1c1c"
MUTED = "#5c5c5c"

CARRIERS = [
    ("int32", "int32"),
    ("double", "double"),
    ("long", "long"),
    ("date", "date"),
    ("decimal128", "decimal128"),
    ("string", "string"),
    ("binary", "binary"),
]
PATTERNS = [
    (1, "Repetitive"),
    (5, "Mixed"),
    (10, "Nearly random"),
]
SERIES = [
    ("zlib", 6, ZLIB, "zlib 6"),
    ("zstd", 3, ZSTD, "zstd 3"),
    ("snappy", None, SNAP, "snappy"),
]

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
        "axes.axisbelow": True,
    }
)


def pick(slice_, carrier, pattern, comp, level, target=None):
    hits = [
        r
        for r in ROWS
        if r["slice"] == slice_
        and r["carrier"] == carrier
        and r["pattern"] == pattern
        and r["compressor"] == comp
        and r["level"] == level
        and (target is None or r["target"] == target)
    ]
    if target is not None:
        if len(hits) != 1:
            raise SystemExit(f"expected 1 row, got {len(hits)} for {slice_} {carrier} pattern {pattern} {comp} {level} t={target}")
        return hits[0]
    hits.sort(key=lambda r: r["target"])
    if not hits:
        raise SystemExit(f"no rows for {slice_} {carrier} pattern {pattern} {comp} {level}")
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
    ax.axhline(1, color="#9a9a9a", lw=1.0, ls=(0, (2, 2)), zorder=1)
    ax.grid(True, which="major", color=GRID, lw=0.8)
    ax.tick_params(length=0)
    ax.margins(x=0.02)


def plot_length(ax, carrier, pattern, ticks):
    ratios = []
    for comp, level, color, _label in SERIES:
        rows = pick("length", carrier, pattern, comp, level)
        xs = [r["target"] for r in rows]
        ys = [r["wireRatio"] for r in rows]
        ratios.extend(ys)
        ax.plot(xs, ys, color=color, lw=2.15, solid_capstyle="round", zorder=3)
    style_axis(ax, ticks)
    bits = pick("length", carrier, pattern, "none", None, 65536)["bits"]
    return bits, min(ratios), max(ratios)


DETAIL_TICKS = [1, 256, 4096, 65536, 1048576, 16777216]


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
        color=color,
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
        arrowprops={"arrowstyle": "-", "color": color, "lw": 0.7},
    )


def mark_carrier(key, axes):
    # Labels use the same rounded figures as the paragraphs under each chart.
    if key == "int32":
        tag_end(axes[0], key, 1, "zstd", 3, "32.4×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "5.2×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "2.7×", SNAP, va="bottom", dy=3)
        tag_end(axes[1], key, 5, "zstd", 3, "30.2×", ZSTD)
        tag_end(axes[2], key, 10, "zstd", 3, "1.84×", ZSTD, va="bottom", dy=4)
        point_at(axes[2], key, 10, "zstd", 3, 512, "zlib and zstd\nabove from 512 B", ZSTD, 16, 18)
        point_at(axes[2], key, 10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, -8, -22)
    elif key == "double":
        tag_end(axes[0], key, 1, "zstd", 3, "86.4×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "6.7×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "3.2×", SNAP, va="bottom", dy=3)
        point_at(axes[0], key, 1, "zstd", 3, 64, "back below", ZSTD, 34, -14)
        point_at(axes[1], key, 5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16)
        point_at(axes[2], key, 10, "snappy", None, 131072, "snappy above\nfrom 128 KiB", SNAP, 12, -20)
    elif key == "long":
        tag_end(axes[0], key, 1, "zstd", 3, "74.2×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "6.7×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "3.2×", SNAP, va="bottom", dy=3)
        point_at(axes[0], key, 1, "zstd", 3, 64, "back below", ZSTD, 34, -14)
        point_at(axes[1], key, 5, "snappy", None, 64, "1 byte longer", SNAP, 36, -16)
        axes[0].text(
            0.03, 0.90, "double finishes at 86.4×",
            transform=axes[0].transAxes, ha="left", va="top", fontsize=8, color=MUTED,
        )
    elif key == "date":
        tag_end(axes[0], key, 1, "zstd", 3, "74.2×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "6.7×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "3.2×", SNAP, va="bottom", dy=3)
        axes[0].text(
            0.03, 0.90, "tracks the long chart",
            transform=axes[0].transAxes, ha="left", va="top", fontsize=8, color=MUTED,
        )
    elif key == "decimal128":
        tag_end(axes[0], key, 1, "zstd", 3, "60.3×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "9.1×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "4.8×", SNAP, va="bottom", dy=3)
        point_at(axes[0], key, 1, "snappy", None, 32, "1.55×", SNAP, 14, 12)
        axes[2].text(
            0.98, 0.90,
            "at 64 KiB: zstd 1.06×, zlib 1.12×\nsnappy above from 128 KiB",
            transform=axes[2].transAxes, ha="right", va="top", fontsize=8, color=MUTED,
        )
    elif key == "string":
        tag_end(axes[0], key, 1, "zstd", 3, "28,728×", ZSTD)
        tag_end(axes[0], key, 1, "zlib", 6, "1,026×", ZLIB, va="bottom", dy=3)
        tag_end(axes[0], key, 1, "snappy", None, "21.3×", SNAP, va="bottom", dy=3)
        tag_end(axes[1], key, 5, "zstd", 3, "10,376×", ZSTD)
        tag_end(axes[1], key, 5, "snappy", None, "21×", SNAP, va="bottom", dy=3)
    elif key == "binary":
        tag_end(axes[0], key, 1, "zstd", 3, "28,728×", ZSTD)
        tag_end(axes[0], key, 1, "snappy", None, "21.3×", SNAP, va="bottom", dy=3)


def mark_combined(axes):
    # The shared scale hides these two results. The paragraphs name them.
    for col, (key, _title) in enumerate(CARRIERS):
        if key == "string":
            axes[1][col].text(
                0.50, 0.78, "snappy below",
                transform=axes[1][col].transAxes, ha="center", va="center", fontsize=8, color=SNAP,
            )
        if key == "binary":
            axes[1][col].text(
                0.50, 0.78, "below the line",
                transform=axes[1][col].transAxes, ha="center", va="center", fontsize=8, color=MUTED,
            )



def carrier_chart(key, title):
    fig, axes = plt.subplots(3, 1, figsize=(9.4, 8.6), sharex=True, constrained_layout=True)
    for ax, (pattern, name) in zip(axes, PATTERNS):
        bits, lo, hi = plot_length(ax, key, pattern, DETAIL_TICKS)
        ax.set_ylim(lo / 1.45, hi * 1.55)
        ax.set_ylabel("Wire ratio")
        ax.set_title(f"{name}  ·  pattern {pattern}  ·  {bits:.3f} bits/byte at 64 KiB", loc="left", fontsize=11, color=INK, pad=8)
        if key == "binary" and pattern == 10:
            ax.text(
                0.98, 0.90,
                "below the line at every size\nat 16 MiB: zstd +406 · snappy +778 · zlib +2,660",
                transform=ax.transAxes, ha="right", va="top", fontsize=8.5, color=MUTED,
            )
        if key == "string" and pattern == 10:
            ax.text(
                0.98, 0.08,
                "snappy stays below the line\n+777 bytes at 16 MiB",
                transform=ax.transAxes, ha="right", va="bottom", fontsize=8.5, color=SNAP,
            )
    axes[-1].set_xlabel("Document target")
    first = {
        "int32": 32,
        "long": 64,
        "double": 64,
        "date": 64,
        "decimal128": 64,
        "string": 32,
        "binary": 32,
    }[key]
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
        color="#8a8a8a",
    )
    mark_carrier(key, axes)
    handles = [
        Line2D([0], [0], color=color, lw=2.4, label=label)
        for _c, _l, color, label in SERIES
    ]
    handles.append(Line2D([0], [0], color="#9a9a9a", lw=1.0, ls=(0, (2, 2)), label="ratio of 1"))
    fig.legend(handles=handles, loc="upper right", frameon=False, bbox_to_anchor=(0.995, 1.005), ncol=4, fontsize=10)
    fig.suptitle(title, fontsize=15, x=0.01, ha="left")
    fig.savefig(OUT / f"{key}.png", dpi=160)
    plt.close(fig)


def combined_chart():
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
    handles = [Line2D([0], [0], color=color, lw=2.4, label=label) for _c, _l, color, label in SERIES]
    handles.append(Line2D([0], [0], color="#9a9a9a", lw=1.0, ls=(0, (2, 2)), label="ratio of 1"))
    fig.legend(handles=handles, loc="upper center", frameon=False, bbox_to_anchor=(0.5, 1.06), ncol=4, fontsize=11)
    fig.suptitle("All seven carriers, on one scale per row", fontsize=15, y=1.10)
    fig.savefig(OUT / "combined.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


def level_chart():
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 5.35))
    fig.subplots_adjust(top=0.78, wspace=0.28, bottom=0.14, left=0.07, right=0.98)

    left = axes[0]
    rows = [
        r
        for r in ROWS
        if r["slice"] == "level64" and r["carrier"] == "int32" and r["pattern"] == 1 and r["compressor"] == "zstd"
    ]
    rows.sort(key=lambda r: r["level"])
    xs = [r["level"] for r in rows]
    ys = [r["wireRatio"] for r in rows]
    left.plot(xs, ys, color=RUST, lw=2.15, zorder=3)
    left.scatter(xs, ys, color=RUST, s=22, zorder=4)
    default = next(r for r in rows if r["level"] == 3)
    left.scatter([3], [default["wireRatio"]], s=78, color=ZSTD, zorder=5, edgecolor="white", linewidth=1.2)
    left.annotate(
        "level 3  13.1×",
        xy=(3, default["wireRatio"]),
        xytext=(5.2, 22),
        fontsize=9,
        color=ZSTD,
        arrowprops={"arrowstyle": "-", "color": ZSTD, "lw": 0.8},
    )
    valley = next(r for r in rows if r["level"] == 13)
    left.annotate(
        "level 13  7.7×",
        xy=(13, valley["wireRatio"]),
        xytext=(15.4, 6.0),
        fontsize=9,
        color=MUTED,
        arrowprops={"arrowstyle": "-", "color": "#b0b0b0", "lw": 0.8},
    )
    peak = next(r for r in rows if r["level"] == 19)
    left.annotate(
        "levels 19–21  36.7×",
        xy=(19, peak["wireRatio"]),
        xytext=(8.5, 39.5),
        fontsize=9,
        color=MUTED,
        arrowprops={"arrowstyle": "-", "color": "#b0b0b0", "lw": 0.8},
    )
    snappy = pick("level64", "int32", 1, "snappy", None, 65536)
    left.axhline(snappy["wireRatio"], color=SNAP, lw=1.2, ls=(0, (3, 2)), zorder=2)
    left.text(-1.6, snappy["wireRatio"] + 1.15, "snappy  2.2×", color=SNAP, fontsize=9, ha="left", va="bottom")
    left.set_xlim(-2, 23)
    left.set_ylim(0, 44)
    left.set_xlabel("zstd level")
    left.set_ylabel("Wire ratio")
    left.set_title("64 KiB array of zero int32s", loc="left", fontsize=12)
    left.grid(True, axis="y", color=GRID, lw=0.8)
    left.tick_params(length=0)
    left.spines["top"].set_visible(False)
    left.spines["right"].set_visible(False)

    right = axes[1]
    sampled = [-1, 1, 3, 6, 9, 19, 22]
    mrows = [
        r
        for r in ROWS
        if r["slice"] == "levelMax"
        and r["carrier"] == "int32"
        and r["pattern"] == 1
        and r["compressor"] == "zstd"
        and r["level"] in sampled
    ]
    mrows.sort(key=lambda r: r["level"])
    right.scatter(
        [r["level"] for r in mrows],
        [r["wireRatio"] for r in mrows],
        c=[ZSTD if r["level"] == 3 else RUST for r in mrows],
        s=42,
        zorder=4,
    )
    d = next(r for r in mrows if r["level"] == 3)
    one = next(r for r in mrows if r["level"] == 1)
    nine = next(r for r in mrows if r["level"] == 9)
    top = next(r for r in mrows if r["level"] == 19)
    right.scatter([3], [d["wireRatio"]], s=84, color=ZSTD, zorder=5, edgecolor="white", linewidth=1.2)
    right.annotate("level 3  32.4×", xy=(3, d["wireRatio"]), xytext=(4.4, 27), fontsize=9, color=ZSTD,
                   arrowprops={"arrowstyle": "-", "color": ZSTD, "lw": 0.8})
    right.annotate("level 1  24.8×", xy=(1, one["wireRatio"]), xytext=(4.6, 17.2), fontsize=9, color=MUTED,
                   arrowprops={"arrowstyle": "-", "color": "#b0b0b0", "lw": 0.8})
    right.annotate("level 9  21.1×", xy=(9, nine["wireRatio"]), xytext=(10.2, 16), fontsize=9, color=MUTED,
                   arrowprops={"arrowstyle": "-", "color": "#b0b0b0", "lw": 0.8})
    right.annotate("level 19  44.6×", xy=(19, top["wireRatio"]), xytext=(12.5, 46.5), fontsize=9, color=MUTED,
                   arrowprops={"arrowstyle": "-", "color": "#b0b0b0", "lw": 0.8})
    sn = pick("levelMax", "int32", 1, "snappy", None, 16777216)
    right.axhline(sn["wireRatio"], color=SNAP, lw=1.2, ls=(0, (3, 2)), zorder=2)
    right.text(22, sn["wireRatio"] + 1.1, "snappy  2.7×", color=SNAP, fontsize=9, ha="right")
    right.set_xlim(-3, 24)
    right.set_ylim(0, 52)
    right.set_xlabel("zstd level")
    right.set_title("16 MiB array of zero int32s, sampled levels", loc="left", fontsize=12)
    right.grid(True, axis="y", color=GRID, lw=0.8)
    right.tick_params(length=0)
    right.spines["top"].set_visible(False)
    right.spines["right"].set_visible(False)

    handles = [
        Line2D([0], [0], color=ZSTD, marker="o", lw=0, ms=8, label="zstd 3, sent when left unset"),
        Line2D([0], [0], color=RUST, lw=2.4, marker="o", ms=5, label="other zstd levels, Rust API only"),
        Line2D([0], [0], color=SNAP, lw=1.2, ls=(0, (3, 2)), label="snappy"),
    ]
    fig.legend(handles=handles, loc="upper center", frameon=False, ncol=3, fontsize=10, bbox_to_anchor=(0.5, 0.98))

    fig.savefig(OUT / "levels.png", dpi=160)
    plt.close(fig)


def surface_rows(carrier, comp, level):
    rows = []
    for pattern in range(1, 11):
        slice_ = "length" if pattern in (1, 5, 10) else "surface"
        rows.extend(
            r
            for r in ROWS
            if r["slice"] == slice_
            and r["carrier"] == carrier
            and r["pattern"] == pattern
            and r["compressor"] == comp
            and r["level"] == level
        )
    return rows


def manifold_chart():
    import numpy as np

    fig = plt.figure(figsize=(17.2, 9.4))
    fig.subplots_adjust(left=0.02, right=0.97, top=0.90, bottom=0.04, wspace=0.16, hspace=0.28)
    for i, (key, title) in enumerate(CARRIERS):
        ax = fig.add_subplot(2, 4, i + 1, projection="3d")
        for comp, level, color, _label in SERIES:
            rows = surface_rows(key, comp, level)
            patterns = sorted({r["pattern"] for r in rows})
            sizes = sorted({r["target"] for r in rows})
            by = {(r["pattern"], r["target"]): r["wireRatio"] for r in rows}
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
        transform=legend_ax.transAxes, ha="center", va="top", fontsize=10, color=MUTED,
    )
    fig.suptitle("Wire ratio over document size and pattern", fontsize=15)
    fig.savefig(OUT / "manifold.png", dpi=140)
    plt.close(fig)


def main():
    for key, title in CARRIERS:
        carrier_chart(key, title)
        print("wrote", key)
    combined_chart()
    print("wrote combined")
    level_chart()
    print("wrote levels")
    manifold_chart()
    print("wrote manifold")


if __name__ == "__main__":
    main()
