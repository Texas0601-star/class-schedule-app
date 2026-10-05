#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成课表 App 的 PWA 图标（纯标准库，无第三方依赖）。
设计：品牌蓝紫渐变底 + 白色日历卡片 + 3x3 课表格子。
"""
import zlib, struct, math, os

BRAND_A = (79, 109, 245)    # #4F6DF5
BRAND_B = (122, 92, 240)    # #7A5CF0
CARD    = (255, 255, 255)
CELL    = (79, 109, 245)
BAND    = (58, 85, 217)     # #3A55D9


def lerp(a, b, t):
    return a + (b - a) * t


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    """圆角矩形有符号距离场（<0 在内部）"""
    dx = abs(px - cx) - hw + r
    dy = abs(py - cy) - hh + r
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - r


def cover(d, aa=1.0):
    """把距离场转成 0..1 覆盖率"""
    return min(max(0.5 - d / aa, 0.0), 1.0)


def render(size, maskable=False):
    px = [[(0, 0, 0)] * size for _ in range(size)]
    cx = cy = size / 2.0

    # 主体缩放：maskable 需要留安全边距
    scale = 0.62 if not maskable else 0.50

    card_hw = size * scale / 2.0
    card_hh = card_hw
    card_r = card_hw * 0.22

    # 顶部品牌色带
    band_h = card_hh * 0.26
    band_top = cy - card_hh
    band_bot = band_top + band_h
    band_r = card_r

    # 3x3 格子
    inner = card_hw * 2 - card_r * 2.4
    gap = inner * 0.16
    cw = (inner - gap * 2) / 3.0
    grid_top = band_bot + (cy + card_hh - band_bot) * 0.16
    grid_h = (cy + card_hh - grid_top) * 0.72
    ch = (grid_h - gap * 2) / 3.0
    grid_left = cx - card_hw + card_r * 1.2

    for y in range(size):
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5

            # 背景对角渐变
            t = (fx + fy) / (size * 2.0)
            col = (
                lerp(BRAND_A[0], BRAND_B[0], t),
                lerp(BRAND_A[1], BRAND_B[1], t),
                lerp(BRAND_A[2], BRAND_B[2], t),
            )

            # 白色卡片
            d = sd_round_rect(fx, fy, cx, cy, card_hw, card_hh, card_r)
            a = cover(d)
            if a > 0:
                r_, g_, b_ = col
                # 卡片顶部色带
                if band_top <= fy <= band_bot:
                    # 带内做圆角裁剪（跟随卡片圆角）
                    inband = cover(sd_round_rect(fx, fy, cx, cy, card_hw, card_hh, card_r))
                    col = (
                        lerp(r_, BAND[0], inband),
                        lerp(g_, BAND[1], inband),
                        lerp(b_, BAND[2], inband),
                    )
                else:
                    col = (lerp(r_, CARD[0], a), lerp(g_, CARD[1], a), lerp(b_, CARD[2], a))
                    # 3x3 课表格子
                    for gi in range(3):
                        for gj in range(3):
                            gx = grid_left + gi * (cw + gap) + cw / 2.0
                            gy = grid_top + gj * (ch + gap) + ch / 2.0
                            dc = sd_round_rect(fx, fy, gx, gy, cw / 2.0, ch / 2.0, ch * 0.28)
                            ac = cover(dc)
                            if ac > 0:
                                col = (
                                    lerp(col[0], CELL[0], ac),
                                    lerp(col[1], CELL[1], ac),
                                    lerp(col[2], CELL[2], ac),
                                )

            px[y][x] = (int(round(col[0])), int(round(col[1])), int(round(col[2])))

    return px


def encode_png(path, grid):
    h = len(grid); w = len(grid[0])
    raw = bytearray()
    for row in grid:
        raw.append(0)
        for (r, g, b) in row:
            raw += bytes((r, g, b))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    out = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", comp)
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    jobs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, mask in jobs:
        grid = render(size, mask)
        n = encode_png(os.path.join(here, name), grid)
        print(f"  {name:26s} {size}x{size}  {n/1024:.1f} KB")
    print("图标生成完成")
