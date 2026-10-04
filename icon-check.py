#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把生成的 Android 图标拼成一张对比图，方便一次性肉眼检查。
背景用棋盘格，这样透明区域能看出来。"""
import zlib, struct, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "android", "app", "src", "main", "res")


def decode_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos, w, h, ct, idat = 8, 0, 0, 0, b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h, _bd, ct = struct.unpack(">IIBB", body[:10])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = 4 if ct == 6 else 3
    stride = w * ch
    px = []
    prev = bytearray(stride)
    i = 0
    for _y in range(h):
        ft = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        # 只用到 filter 0/1/2/3/4 的全集实现（自己的编码器只写 0，但留个兜底）
        if ft == 1:
            for k in range(ch, stride):
                line[k] = (line[k] + line[k - ch]) & 0xFF
        elif ft == 2:
            for k in range(stride):
                line[k] = (line[k] + prev[k]) & 0xFF
        elif ft == 3:
            for k in range(stride):
                a = line[k - ch] if k >= ch else 0
                line[k] = (line[k] + ((a + prev[k]) >> 1)) & 0xFF
        elif ft == 4:
            for k in range(stride):
                a = line[k - ch] if k >= ch else 0
                b = prev[k]
                c = prev[k - ch] if k >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[k] = (line[k] + pr) & 0xFF
        row = []
        for x in range(w):
            o = x * ch
            if ch == 4:
                row.append((line[o], line[o + 1], line[o + 2], line[o + 3]))
            else:
                row.append((line[o], line[o + 1], line[o + 2], 255))
        px.append(row)
        prev = line
    return w, h, px


def encode_png(path, grid):
    h = len(grid); w = len(grid[0])
    raw = bytearray()
    for row in grid:
        raw.append(0)
        for p in row:
            raw += bytes(p)
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, d):
        return struct.pack(">I", len(d)) + tag + d + struct.pack(">I", zlib.crc32(tag + d) & 0xFFFFFFFF)

    open(path, "wb").write(b"\x89PNG\r\n\x1a\n"
                           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                           + chunk(b"IDAT", comp) + chunk(b"IEND", b""))


def checker(x, y, s=12):
    return (232, 234, 240) if ((x // s + y // s) % 2 == 0) else (208, 211, 220)


def blit(dst, src_w, src_h, src, ox, oy, cell, bg_mode):
    """把 src 缩放到 cell x cell 后贴到 (ox,oy)。bg_mode: 'checker' | 'dark'"""
    for y in range(cell):
        for x in range(cell):
            sx = min(src_w - 1, int(x * src_w / cell))
            sy = min(src_h - 1, int(y * src_h / cell))
            r, g, b, a = src[sy][sx]
            if bg_mode == "dark":
                base = (40, 42, 52)
            else:
                base = checker(ox + x, oy + y)
            af = a / 255.0
            dst[oy + y][ox + x] = (
                int(r * af + base[0] * (1 - af)),
                int(g * af + base[1] * (1 - af)),
                int(b * af + base[2] * (1 - af)),
                255,
            )


def main():
    items = [
        ("方形图标 192", os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher.png"), "checker", 160),
        ("圆形图标 192", os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_round.png"), "checker", 160),
        ("自适应前景 432", os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_foreground.png"), "checker", 160),
        ("通知图标 96", os.path.join(RES, "drawable-xxxhdpi", "ic_stat_icon.png"), "dark", 160),
        ("小尺寸 48（真实观感）", os.path.join(RES, "mipmap-mdpi", "ic_launcher.png"), "checker", 48),
        ("通知 24（真实观感）", os.path.join(RES, "drawable-mdpi", "ic_stat_icon.png"), "dark", 24),
    ]
    pad, label_h = 16, 22
    cols = 6
    cw = max(i[3] for i in items)
    W = pad + cols * (cw + pad)
    H = pad + label_h + cw + pad
    grid = [[(255, 255, 255, 255)] * W for _ in range(H)]

    for i, (name, path, mode, cell) in enumerate(items):
        w, h, px = decode_png(path)
        ox = pad + i * (cw + pad)
        blit(grid, w, h, px, ox, pad + label_h, cell, mode)

    out = os.path.join(HERE, "icon-check.png")
    encode_png(out, grid)
    print("对比图: " + out + "  (%dx%d)" % (W, H))
    for name, path, _m, _c in items:
        print("  %-22s %s" % (name, os.path.relpath(path, RES)))


if __name__ == "__main__":
    main()
