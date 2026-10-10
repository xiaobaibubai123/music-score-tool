# -*- coding: utf-8 -*-
"""
五线谱音符头自动检测 —— 从谱面图片推算音高序列。

思路
    音符头是约 20x14 像素的实心椭圆。用「滑动窗口内的暗像素密度」来找它，
    比连通域分析更稳：不会被五线谱线、符干、符杠干扰。

已知局限（务必读完）
    1. 只能检测【实心】音符头。二分音符/全音符是空心的，密度低，会漏检 ——
       那些音符的位置和音高请从简谱的音级与 `-` 推出。
    2. 谱号、调号、符杠会被误判成音符头，需要人工剔除。
       典型表现是每行开头多出两个假音。
    3. 每个谱表的谱线 y 位置必须单独检测（不同系统之间偏移不同）。
    4. 检测结果【必须】先用一段已知答案的乐段校准，再用来读未知乐段。

用法
    python detect-notes.py <图片> <y0> <y1> [--clef treble|bass] [--flats BEA] [--min-x 650]

    y0 / y1 是要检测的那一行谱表的上下边界（可用 crop.py sys 切出来看）。

输出
    每个候选音符的 x / y / 尺寸，以及推算出的音名与序列。
"""
import argparse
import re
import sys

import numpy as np
from PIL import Image

LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def name_to_idx(n):
    """自然音级序号，以 C4 = 0"""
    m = re.match(r'^([A-G])(-?\d+)$', n)
    return (int(m.group(2)) - 4) * 7 + LETTERS.index(m.group(1))


def idx_to_name(i):
    return LETTERS[i % 7] + str(4 + i // 7)


# 谱号对应的「最下面一条线」的基准音
CLEF_BASE = {'treble': 'E4', 'bass': 'G2'}


def integral(mask):
    return np.pad(mask.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))


def dens_map(ii, H, W, w, h):
    """每个像素作为窗口左上角时的平均暗像素密度"""
    ys = np.arange(0, H - h + 1)
    xs = np.arange(0, W - w + 1)
    out = np.zeros((len(ys), len(xs)), dtype=np.float32)
    for a, yy in enumerate(ys):
        out[a, :] = (ii[yy + h, xs + w] - ii[yy, xs + w]
                     - ii[yy + h, xs] + ii[yy, xs]) / (w * h)
    return out


def label(mask, pad_w, pad_h):
    """简单的连通域标注（BFS）"""
    visited = np.zeros_like(mask, dtype=bool)
    out = []
    yy, xx = np.nonzero(mask)
    for a0, b0 in zip(yy.tolist(), xx.tolist()):
        if visited[a0, b0]:
            continue
        st = [(a0, b0)]
        visited[a0, b0] = True
        miny = maxy = a0
        minx = maxx = b0
        n = 0
        while st:
            a, b = st.pop()
            n += 1
            miny, maxy = min(miny, a), max(maxy, a)
            minx, maxx = min(minx, b), max(maxx, b)
            for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                na, nb = a + da, b + db
                if 0 <= na < mask.shape[0] and 0 <= nb < mask.shape[1] \
                        and mask[na, nb] and not visited[na, nb]:
                    visited[na, nb] = True
                    st.append((na, nb))
        if n >= 3:
            out.append({'cx': (minx + maxx) / 2 + pad_w / 2,
                        'cy': (miny + maxy) / 2 + pad_h / 2,
                        'w': maxx - minx + pad_w,
                        'h': maxy - miny + pad_h,
                        'area': n})
    return out


def find_noteheads(arr, y0, y1, min_x=0, dens=0.62,
                   w_range=(28, 58), h_range=(20, 46)):
    """在 y0..y1 这段里找实心音符头"""
    band = (arr[y0:y1, :] < 150)
    H, W = band.shape
    ii = integral(band)
    filled = dens_map(ii, H, W, 20, 14) > dens
    cand = []
    for c in label(filled, 20, 14):
        c['cy'] += y0
        if c['cx'] < min_x:
            continue
        if not (w_range[0] <= c['w'] <= w_range[1]):
            continue
        if not (h_range[0] <= c['h'] <= h_range[1]):
            continue
        cand.append(c)
    # 去掉中心靠得过近的重复项
    cand.sort(key=lambda c: c['cx'])
    dedup = []
    for c in cand:
        if dedup and abs(c['cx'] - dedup[-1]['cx']) < 14 and abs(c['cy'] - dedup[-1]['cy']) < 14:
            continue
        dedup.append(c)
    return dedup


def staff_lines(arr, y0, y1, frac=0.45):
    """找出 y0..y1 里五线谱线的 y 坐标（整行大量暗像素）"""
    band = (arr[y0:y1, :] < 150)
    rows = band.sum(axis=1) / band.shape[1]
    cand = [i for i, f in enumerate(rows) if f > frac]
    lines, cur = [], []
    for i in cand:
        if cur and i - cur[-1] > 3:
            lines.append(int(np.mean(cur)) + y0)
            cur = []
        cur.append(i)
    if cur:
        lines.append(int(np.mean(cur)) + y0)
    return lines


def main():
    ap = argparse.ArgumentParser(description='五线谱音符头检测')
    ap.add_argument('image')
    ap.add_argument('y0', type=int)
    ap.add_argument('y1', type=int)
    ap.add_argument('--clef', default='treble', choices=['treble', 'bass'])
    ap.add_argument('--flats', default='', help='调号里需要降半音的音名字母，如 BEA')
    ap.add_argument('--min-x', type=int, default=0, help='跳过谱号/调号区域')
    args = ap.parse_args()

    arr = np.array(Image.open(args.image).convert('L'))

    lines = staff_lines(arr, args.y0, args.y1)
    print(f'谱线 y 坐标: {lines}')
    if len(lines) < 2:
        print('✖ 没检测到谱线，请检查 y0 / y1 范围')
        sys.exit(1)

    nh = find_noteheads(arr, args.y0, args.y1, min_x=args.min_x)
    print(f'检测到候选音符头 {len(nh)} 个\n')

    lines = sorted(lines)
    spacing = (lines[-1] - lines[0]) / (len(lines) - 1)
    half = spacing / 2
    base = name_to_idx(CLEF_BASE[args.clef])

    seq = []
    for c in nh:
        steps = round((lines[-1] - c['cy']) / half)
        name = idx_to_name(base + steps)
        if name[0] in args.flats:
            name = name[0] + 'b' + name[1:]
        seq.append(name)
        print(f"  x={c['cx']:7.1f} y={c['cy']:7.1f} w={c['w']:3d} h={c['h']:3d}"
              f" 面积={c['area']:4d}  → {name}")
    print('\n音高序列: ' + ' '.join(seq))


if __name__ == '__main__':
    main()
