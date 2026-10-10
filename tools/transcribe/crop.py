# -*- coding: utf-8 -*-
"""
谱面切图工具 —— 把大的谱面图片按谱表行切开、放大，方便逐行精读。

用法：
    python crop.py sys  <图片> [输出目录]              # 按「系统」整行切（上下两行谱表为一组）
    python crop.py line <图片> [输出目录]              # 按单个谱表行切（旋律行/伴奏行分开）
    python crop.py zoom <图片> x0 y0 x1 y1 [倍数] [输出]    # 指定区域放大

经验：
    切出来的图控制在 1.5M 像素以内，否则看图工具会自动降采样，反而更糊。
    2400×350 的整行够看清数字；要看八度点建议 1200×200 再放大 2 倍。
"""
import os
import sys

import numpy as np
from PIL import Image

MAX_PIXELS = 1_500_000


def row_bands(gray, thresh=160, min_gap=18, min_h=40, row_frac=0.008):
    """用横向暗像素投影找出谱表行的上下边界"""
    dark = (gray < thresh).sum(axis=1)
    occupied = dark > gray.shape[1] * row_frac
    bands, start, gap = [], None, 0
    for y, occ in enumerate(occupied):
        if occ:
            if start is None:
                start = y
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                if y - gap - start >= min_h:
                    bands.append((start, y - gap))
                start = None
    if start is not None and len(occupied) - start >= min_h:
        bands.append((start, len(occupied) - 1))
    return bands


def fit_scale(w, h, scale):
    """限制总像素，避免被读图工具降采样"""
    while w * h * scale * scale > MAX_PIXELS and scale > 1:
        scale = round(scale - 0.2, 2)
    return scale


def save(img, box, scale, out_path, pad=12):
    x0, y0, x1, y1 = box
    W, H = img.size
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    y0, y1 = max(0, y0 - pad), min(H, y1 + pad)
    c = img.crop((x0, y0, x1, y1))
    s = fit_scale(c.width, c.height, scale)
    if s != 1:
        c = c.resize((int(c.width * s), int(c.height * s)), Image.LANCZOS)
    c.save(out_path)
    print(f'  {out_path}  {c.size[0]}x{c.size[1]}  (放大 {s}x)')


def do_sys(path, outdir):
    """上下两个谱表行合并成一个「系统」，整行切出"""
    img = Image.open(path).convert('RGB')
    gray = np.array(img.convert('L'))
    bands = row_bands(gray)
    systems, i = [], 0
    while i < len(bands):
        y0 = bands[i][0]
        y1 = bands[i + 1][1] if i + 1 < len(bands) else bands[i][1]
        systems.append((0, y0, img.size[0], y1))
        i += 2
    print(f'{path}: 检测到 {len(bands)} 个谱表行 → {len(systems)} 个系统')
    base = os.path.splitext(os.path.basename(path))[0]
    for k, box in enumerate(systems):
        save(img, box, 2300 / img.size[0], os.path.join(outdir, f'{base}_sys{k+1}.png'), pad=42)


def do_line(path, outdir):
    """每个谱表行单独切出（旋律行 / 伴奏行分离），再左右分半"""
    img = Image.open(path).convert('RGB')
    gray = np.array(img.convert('L'))
    bands = row_bands(gray, row_frac=0.01)
    W = img.size[0]
    print(f'{path}: 检测到 {len(bands)} 个谱表行')
    base = os.path.splitext(os.path.basename(path))[0]
    for i, (y0, y1) in enumerate(bands):
        for tag, (x0, x1) in (('L', (0, W // 2 + 60)), ('R', (W // 2 - 60, W))):
            save(img, (x0, y0, x1, y1), 1.3, os.path.join(outdir, f'{base}_r{i+1}_{tag}.png'), pad=12)


def do_zoom(path, box, scale, out_path):
    img = Image.open(path).convert('RGB')
    save(img, box, scale, out_path, pad=0)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    mode, src = sys.argv[1], sys.argv[2]
    if mode == 'sys':
        out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(src), 'crops_sys')
        os.makedirs(out, exist_ok=True)
        do_sys(src, out)
    elif mode == 'line':
        out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(src), 'crops_line')
        os.makedirs(out, exist_ok=True)
        do_line(src, out)
    elif mode == 'zoom':
        if len(sys.argv) < 7:
            print('用法: python crop.py zoom <图片> x0 y0 x1 y1 [倍数] [输出文件]')
            sys.exit(1)
        x0, y0, x1, y1 = (int(v) for v in sys.argv[3:7])
        scale = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
        out = sys.argv[8] if len(sys.argv) > 8 else os.path.join(
            os.path.dirname(src), 'zoom.png')
        do_zoom(src, (x0, y0, x1, y1), scale, out)
    else:
        print(__doc__)
        sys.exit(1)
