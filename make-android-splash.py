#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Android 启动图（splash），替换 Capacitor 模板自带的默认 logo。

复用 make-android-icons.py 里的距离场渲染器 —— 启动图是「品牌渐变底 + 居中图标」，
和图标用的是同一套几何，只是画布尺寸不同。因为渲染是解析式的，
1280x1920 也是直接算出来的，不是把小图拉大。

性能说明：纯 Python 逐像素很慢，所以做了两处优化 ——
  1) 渐变是线性的，每行只算起点和增量，不在内层循环里做 lerp
  2) 卡片只在其包围盒内求值，包围盒外直接跳过（占总面积不到 15%）

用法：python make-android-splash.py
"""
import os, sys, time, math, zlib, struct

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "android", "app", "src", "main", "res")

BRAND_A = (79, 109, 245)    # #4F6DF5
BRAND_B = (122, 92, 240)    # #7A5CF0
CARD    = (255, 255, 255)
CELL    = (79, 109, 245)
BAND    = (58, 85, 217)

# Capacitor 模板里 splash 的实际尺寸，保持一一对应（换尺寸会导致拉伸）
JOBS = [
    ("drawable/splash.png",             480, 320),
    ("drawable-port-mdpi/splash.png",   320, 480),
    ("drawable-port-hdpi/splash.png",   480, 800),
    ("drawable-port-xhdpi/splash.png",  720, 1280),
    ("drawable-port-xxhdpi/splash.png", 960, 1600),
    ("drawable-port-xxxhdpi/splash.png",1280, 1920),
    ("drawable-land-mdpi/splash.png",   480, 320),
    ("drawable-land-hdpi/splash.png",   800, 480),
    ("drawable-land-xhdpi/splash.png",  1280, 720),
    ("drawable-land-xxhdpi/splash.png", 1600, 960),
    ("drawable-land-xxxhdpi/splash.png",1920, 1280),
]

LOGO_RATIO = 0.30           # 图标占短边的比例


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - hw + r
    dy = abs(py - cy) - hh + r
    return math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - r


def cover(d, aa=1.0):
    return min(max(0.5 - d / aa, 0.0), 1.0)


def render(w, h):
    logo = min(w, h) * LOGO_RATIO
    cx, cy = w / 2.0, h / 2.0
    hw = logo / 2.0
    r = hw * 0.22

    band_h = hw * 2 * 0.26
    band_top, band_bot = cy - hw, cy - hw + band_h

    inner = hw * 2 - r * 2.4
    gap = inner * 0.16
    cw = (inner - gap * 2) / 3.0
    grid_top = band_bot + (cy + hw - band_bot) * 0.16
    grid_h = (cy + hw - grid_top) * 0.72
    ch = (grid_h - gap * 2) / 3.0
    grid_left = cx - hw + r * 1.2

    aa = max(1.0, min(w, h) / 480.0)

    # 卡片包围盒（留出抗锯齿余量），盒外只画渐变
    m = aa * 2 + 2
    bx0, bx1 = int(max(0, cx - hw - m)), int(min(w, cx + hw + m + 1))
    by0, by1 = int(max(0, cy - hw - m)), int(min(h, cy + hw + m + 1))

    # 渐变 t = (x + y) / (w + h)，对 x 线性 → 每行只算一次增量
    t_span = float(w + h)
    dr = (BRAND_B[0] - BRAND_A[0]) / t_span
    dg = (BRAND_B[1] - BRAND_A[1]) / t_span
    db = (BRAND_B[2] - BRAND_A[2]) / t_span

    rows = []
    for y in range(h):
        fy = y + 0.5
        t0 = fy / t_span
        r0 = BRAND_A[0] + (BRAND_B[0] - BRAND_A[0]) * t0
        g0 = BRAND_A[1] + (BRAND_B[1] - BRAND_A[1]) * t0
        b0 = BRAND_A[2] + (BRAND_B[2] - BRAND_A[2]) * t0
        row = []
        in_band = by0 <= y < by1
        for x in range(w):
            rr, gg, bb = r0 + dr * (x + 0.5), g0 + dg * (x + 0.5), b0 + db * (x + 0.5)
            if in_band and bx0 <= x < bx1:
                fx = x + 0.5
                a = cover(sd_round_rect(fx, fy, cx, cy, hw, hw, r), aa)
                if a > 0:
                    if band_top <= fy <= band_bot:
                        cr, cg, cb = BAND
                    else:
                        cr, cg, cb = CARD
                        for gi in range(3):
                            for gj in range(3):
                                gx = grid_left + gi * (cw + gap) + cw / 2.0
                                gy = grid_top + gj * (ch + gap) + ch / 2.0
                                ac = cover(sd_round_rect(fx, fy, gx, gy, cw / 2.0, ch / 2.0, ch * 0.28), aa)
                                if ac > 0:
                                    cr += (CELL[0] - cr) * ac
                                    cg += (CELL[1] - cg) * ac
                                    cb += (CELL[2] - cb) * ac
                    rr += (cr - rr) * a
                    gg += (cg - gg) * a
                    bb += (cb - bb) * a
            row.append((int(rr), int(gg), int(bb), 255))
        rows.append(row)
    return rows


def encode_png(path, grid):
    h, w = len(grid), len(grid[0])
    raw = bytearray()
    for row in grid:
        raw.append(0)
        for px in row:
            raw += bytes(px)
    comp = zlib.compress(bytes(raw), 6)

    def chunk(tag, d):
        return struct.pack(">I", len(d)) + tag + d + struct.pack(">I", zlib.crc32(tag + d) & 0xFFFFFFFF)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", comp) + chunk(b"IEND", b""))


def main():
    if not os.path.isdir(RES):
        print("找不到 Android 资源目录：" + RES, file=sys.stderr)
        return 1
    t0 = time.time()
    total = 0
    for rel, w, h in JOBS:
        p = os.path.join(RES, rel.replace("/", os.sep))
        encode_png(p, render(w, h))
        n = os.path.getsize(p)
        total += n
        print("  %-36s %4dx%-5d %6.1f KB" % (rel, w, h, n / 1024))
    print("\n完成：%d 张启动图，共 %.1f KB，耗时 %.1f 秒" % (len(JOBS), total / 1024, time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
