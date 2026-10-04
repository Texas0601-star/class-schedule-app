#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Android 全套图标（纯标准库，不依赖 Pillow）。

为什么不用 Pillow：本机没装，装一次要好几分钟，而且这里要的只是
「几何图形 + 抗锯齿 + 输出 PNG」，标准库足够。渲染器是解析式的
（有符号距离场），任意尺寸都能直接算出来，不需要位图缩放 —— 放大
到 432px 也不会糊。

产出：
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png          传统方形图标（圆角已烘焙）
  mipmap-*/ic_launcher_round.png                                    传统圆形图标
  mipmap-*/ic_launcher_foreground.png                               自适应图标前景层（透明底）
  drawable-*/ic_stat_icon.png                                       通知栏单色图标（只有 alpha 有意义）
  mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml          自适应图标声明
  drawable/ic_launcher_background.xml                               自适应图标背景层（渐变）

用法：python make-android-icons.py
"""
import zlib, struct, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "android", "app", "src", "main", "res")

BRAND_A = (79, 109, 245)    # #4F6DF5
BRAND_B = (122, 92, 240)    # #7A5CF0
CARD    = (255, 255, 255)
CELL    = (79, 109, 245)
BAND    = (58, 85, 217)     # #3A55D9

# 传统图标尺寸（Android 官方密度倍率 1/1.5/2/3/4）
LEGACY = [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]
# 自适应图标前景层：108dp 画布，可见安全区只有中间 72dp
ADAPTIVE = [("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324), ("xxxhdpi", 432)]
# 通知栏图标：24dp
NOTIF = [("mdpi", 24), ("hdpi", 36), ("xhdpi", 48), ("xxhdpi", 72), ("xxxhdpi", 96)]


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
    """距离场 → 0..1 覆盖率（aa 是抗锯齿过渡宽度）"""
    return min(max(0.5 - d / aa, 0.0), 1.0)


def over(dst, src, a):
    """把 src 以不透明度 a 叠到 dst 上（都按 0..255 的浮点算）"""
    return (lerp(dst[0], src[0], a), lerp(dst[1], src[1], a), lerp(dst[2], src[2], a))


def gradient(fx, fy, size):
    t = (fx + fy) / (size * 2.0)
    return (lerp(BRAND_A[0], BRAND_B[0], t),
            lerp(BRAND_A[1], BRAND_B[1], t),
            lerp(BRAND_A[2], BRAND_B[2], t))


def card_geometry(size, scale):
    """返回白色卡片 + 顶部色带 + 3x3 格子的几何参数"""
    cx = cy = size / 2.0
    card_hw = size * scale / 2.0
    card_r = card_hw * 0.22
    band_h = card_hw * 0.26
    band_top = cy - card_hw
    band_bot = band_top + band_h
    inner = card_hw * 2 - card_r * 2.4
    gap = inner * 0.16
    cw = (inner - gap * 2) / 3.0
    grid_top = band_bot + (cy + card_hw - band_bot) * 0.16
    grid_h = (cy + card_hw - grid_top) * 0.72
    ch = (grid_h - gap * 2) / 3.0
    grid_left = cx - card_hw + card_r * 1.2
    return dict(cx=cx, cy=cy, hw=card_hw, r=card_r, band_top=band_top, band_bot=band_bot,
                cw=cw, ch=ch, gap=gap, grid_top=grid_top, grid_left=grid_left)


def draw_card(fx, fy, size, scale, g, clip=None):
    """画白色卡片层。返回 (r,g,b,a)，a 为 0..1。clip 传入一个覆盖率函数用于外轮廓裁剪。"""
    if clip is not None and clip <= 0:
        return None
    d = sd_round_rect(fx, fy, g["cx"], g["cy"], g["hw"], g["hw"], g["r"])
    a = cover(d)
    if a <= 0:
        return None
    if clip is not None:
        a *= clip
    # 卡片底色
    col = over((0, 0, 0), CARD, 1.0)
    if g["band_top"] <= fy <= g["band_bot"]:
        col = over(col, BAND, 1.0)
    else:
        for gi in range(3):
            for gj in range(3):
                gx = g["grid_left"] + gi * (g["cw"] + g["gap"]) + g["cw"] / 2.0
                gy = g["grid_top"] + gj * (g["ch"] + g["gap"]) + g["ch"] / 2.0
                ac = cover(sd_round_rect(fx, fy, gx, gy, g["cw"] / 2.0, g["ch"] / 2.0, g["ch"] * 0.28))
                if ac > 0:
                    col = over(col, CELL, ac)
    return (col[0], col[1], col[2], a)


def render_legacy(size, round_mask=False):
    """传统图标：渐变底铺满 + 白色卡片。方形版本烘焙圆角，圆形版本裁成圆。"""
    g = card_geometry(size, 0.62)
    radius = size * 0.18 if not round_mask else size / 2.0
    aa = max(1.0, size / 96.0)
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            if round_mask:
                d_out = math.hypot(fx - size / 2.0, fy - size / 2.0) - size / 2.0
            else:
                d_out = sd_round_rect(fx, fy, size / 2.0, size / 2.0, size / 2.0, size / 2.0, radius)
            clip = cover(d_out, aa)
            if clip <= 0:
                row.append((0, 0, 0, 0))
                continue
            col = over((0, 0, 0), gradient(fx, fy, size), 1.0)
            c = draw_card(fx, fy, size, 0.62, g)
            if c:
                col = over(col, (c[0], c[1], c[2]), c[3])
            row.append((int(round(col[0])), int(round(col[1])), int(round(col[2])), int(round(clip * 255))))
        out.append(row)
    return out


def render_foreground(size):
    """自适应图标前景层：只有白色卡片，其余全透明。
    内容缩到 62%，正好落在 72/108 的安全区里，被任何形状裁切都不会缺角。"""
    g = card_geometry(size, 0.62)
    aa = max(1.0, size / 108.0)
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            c = draw_card(x + 0.5, y + 0.5, size, 0.62, g)
            if not c:
                row.append((0, 0, 0, 0))
            else:
                row.append((int(round(c[0])), int(round(c[1])), int(round(c[2])), int(round(c[3] * 255))))
        out.append(row)
    return out


def render_notif(size):
    """通知栏图标：Android 只取 alpha 通道，所以必须是纯白剪影。
    设计成一个「课程表」：白色圆角卡片，顶部色带挖空，下面三条横杠挖空。
    小尺寸下比画 3x3 格子更容易辨认。"""
    aa = max(1.0, size / 24.0)
    pad = size * 0.10
    hw = size / 2.0 - pad
    r = hw * 0.22
    cx = cy = size / 2.0
    band_bot = cy - hw + hw * 2 * 0.26          # 色带下沿
    rows = 3
    gap = hw * 2 * 0.085
    top = band_bot + hw * 2 * 0.11
    bottom = cy + hw - hw * 2 * 0.13
    rh = ((bottom - top) - gap * (rows - 1)) / rows
    left = cx - hw + hw * 2 * 0.20
    right = cx + hw - hw * 2 * 0.20

    out = []
    for y in range(size):
        row = []
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            a = cover(sd_round_rect(fx, fy, cx, cy, hw, hw, r), aa)
            if a > 0:
                # 挖掉顶部色带
                if fy < band_bot:
                    a = min(a, 1.0 - cover(sd_round_rect(fx, fy, cx, cy, hw, hw, r), aa))
                else:
                    for i in range(rows):
                        ry = top + i * (rh + gap) + rh / 2.0
                        rb = cover(sd_round_rect(fx, fy, (left + right) / 2.0, ry,
                                                 (right - left) / 2.0, rh / 2.0, rh * 0.32), aa)
                        a = min(a, 1.0 - rb)
            row.append((255, 255, 255, int(round(max(a, 0.0) * 255))))
        out.append(row)
    return out


def encode_png(path, grid):
    """RGBA PNG（color type 6）。grid 每项是 (r,g,b,a)。"""
    h = len(grid); w = len(grid[0])
    raw = bytearray()
    for row in grid:
        raw.append(0)                      # filter type 0
        for px in row:
            raw += bytes(px)
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    out = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", comp)
           + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""

BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标的背景层。用 XML 渐变而不是位图，任何屏幕密度都不用换图。 -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <gradient
        android:angle="315"
        android:startColor="#4F6DF5"
        android:endColor="#7A5CF0"
        android:type="linear" />
</shape>
"""


def main():
    if not os.path.isdir(RES):
        print("找不到 Android 资源目录：" + RES, file=sys.stderr)
        print("先在 class-schedule-mobile 里跑 `npx cap add android`。", file=sys.stderr)
        return 1

    total = 0

    for dens, size in LEGACY:
        d = os.path.join(RES, "mipmap-" + dens)
        total += encode_png(os.path.join(d, "ic_launcher.png"), render_legacy(size, False))
        total += encode_png(os.path.join(d, "ic_launcher_round.png"), render_legacy(size, True))
        print("  mipmap-%-8s ic_launcher(_round)  %dpx" % (dens, size))

    for dens, size in ADAPTIVE:
        d = os.path.join(RES, "mipmap-" + dens)
        total += encode_png(os.path.join(d, "ic_launcher_foreground.png"), render_foreground(size))
        print("  mipmap-%-8s ic_launcher_foreground  %dpx" % (dens, size))

    for dens, size in NOTIF:
        d = os.path.join(RES, "drawable-" + dens)
        total += encode_png(os.path.join(d, "ic_stat_icon.png"), render_notif(size))
        print("  drawable-%-6s ic_stat_icon  %dpx" % (dens, size))

    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        p = os.path.join(RES, "mipmap-anydpi-v26", name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(ADAPTIVE_XML)
        print("  mipmap-anydpi-v26 " + name)

    p = os.path.join(RES, "drawable", "ic_launcher_background.xml")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(BACKGROUND_XML)
    print("  drawable        ic_launcher_background.xml")

    print("\n完成：%d 张位图，共 %.1f KB" % (len(LEGACY) * 2 + len(ADAPTIVE) + len(NOTIF), total / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
