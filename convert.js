'use strict';

// 写真 → ドット絵の変換処理。
// 1. Kuwaharaフィルタで写真の細かい陰影を平らにする
// 2. ドット数まで縮小し、Lab色空間のk-meansで色をまとめる
// 3. ポツンと浮いたドットを周りに揃える
// 4. 配色プリセットを当て、明るさが大きく変わる境目に線を入れる

const PixelConvert = (() => {
  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };

  // 半分ずつ縮小してから目標サイズにする（一気に縮めるとガタつくため）
  function scaleTo(src, w, h) {
    let cur = src;
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const next = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
      const ctx = next.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, next.width, next.height);
      cur = next;
    }
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, w, h);
    return out;
  }

  // ---- 色空間 ----
  function rgb2lab(r, g, b) {
    const lin = (v) => {
      v /= 255;
      return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
    };
    r = lin(r); g = lin(g); b = lin(b);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function lab2rgb(L, a, b) {
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
    const x = f(fx) * 0.95047;
    const y = f(fy);
    const z = f(fz) * 1.08883;
    const rgb = [
      x * 3.2406 + y * -1.5372 + z * -0.4986,
      x * -0.9689 + y * 1.8758 + z * 0.0415,
      x * 0.0557 + y * -0.2040 + z * 1.0570,
    ];
    return rgb.map((v) => {
      v = v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v;
      return Math.max(0, Math.min(255, Math.round(v * 255)));
    });
  }

  // ---- 1. 陰影を平らにする（Kuwaharaフィルタ） ----
  function kuwahara(src, r) {
    const W = src.width;
    const H = src.height;
    const s = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const out = makeCanvas(W, H);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const quads = [[-r, -r], [0, -r], [-r, 0], [0, 0]];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let best = Infinity;
        let br = 0, bg = 0, bb = 0;
        for (const [sx, sy] of quads) {
          let n = 0, mr = 0, mg = 0, mb = 0, sq = 0;
          for (let yy = y + sy; yy <= y + sy + r; yy++) {
            const cy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
            for (let xx = x + sx; xx <= x + sx + r; xx++) {
              const cx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
              const k = (cy * W + cx) * 4;
              const pr = s[k], pg = s[k + 1], pb = s[k + 2];
              mr += pr; mg += pg; mb += pb;
              sq += pr * pr + pg * pg + pb * pb;
              n++;
            }
          }
          mr /= n; mg /= n; mb /= n;
          const variance = sq / n - (mr * mr + mg * mg + mb * mb);
          if (variance < best) {
            best = variance;
            br = mr; bg = mg; bb = mb;
          }
        }
        const k = (y * W + x) * 4;
        d[k] = br; d[k + 1] = bg; d[k + 2] = bb; d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // ---- 2. 色をまとめる（Lab空間のk-means。鮮やかな色と画面中央を重く見る） ----
  function quantize(src, K) {
    const W = src.width;
    const H = src.height;
    const p = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const N = W * H;
    const lab = new Float32Array(N * 3);
    const wt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const [L, a, b] = rgb2lab(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]);
      lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b;
      const cx = (i % W) / W - 0.5;
      const cy = Math.floor(i / W) / H - 0.5;
      wt[i] = (1 + Math.hypot(a, b) / 25) * (1.3 - Math.hypot(cx, cy));
    }
    const dist = (i, c) => {
      const dL = lab[i * 3] - c[0], da = lab[i * 3 + 1] - c[1], db = lab[i * 3 + 2] - c[2];
      return dL * dL + da * da + db * db;
    };

    // 初期値：互いに遠い色を順に選ぶ（k-means++の決定版）
    const mid = Math.floor(H / 2) * W + Math.floor(W / 2);
    let cent = [[lab[mid * 3], lab[mid * 3 + 1], lab[mid * 3 + 2]]];
    const minD = new Float32Array(N).fill(Infinity);
    while (cent.length < K) {
      const last = cent[cent.length - 1];
      let best = -1, bi = 0;
      for (let i = 0; i < N; i++) {
        const dd = dist(i, last);
        if (dd < minD[i]) minD[i] = dd;
        const score = minD[i] * wt[i];
        if (score > best) { best = score; bi = i; }
      }
      if (best <= 0) break;
      cent.push([lab[bi * 3], lab[bi * 3 + 1], lab[bi * 3 + 2]]);
    }

    const lbl = new Int32Array(N);
    for (let it = 0; it < 12; it++) {
      const sum = cent.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < N; i++) {
        let m = Infinity, k = 0;
        for (let j = 0; j < cent.length; j++) {
          const dd = dist(i, cent[j]);
          if (dd < m) { m = dd; k = j; }
        }
        lbl[i] = k;
        const w = wt[i];
        sum[k][0] += lab[i * 3] * w;
        sum[k][1] += lab[i * 3 + 1] * w;
        sum[k][2] += lab[i * 3 + 2] * w;
        sum[k][3] += w;
      }
      cent = sum.map((v, j) => (v[3] ? [v[0] / v[3], v[1] / v[3], v[2] / v[3]] : cent[j]));
    }
    return { W, H, lbl, cent };
  }

  // ---- 3. ポツンと浮いたドットを周りの多数派に揃える ----
  function cleanup(q) {
    const { W, H, lbl } = q;
    const out = new Int32Array(lbl);
    const cnt = new Map();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        cnt.clear();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const l = lbl[yy * W + xx];
            cnt.set(l, (cnt.get(l) || 0) + 1);
          }
        }
        const me = lbl[y * W + x];
        if (cnt.get(me) <= 2) {
          let best = me, bc = 0;
          for (const [k, c] of cnt) if (c > bc) { bc = c; best = k; }
          out[y * W + x] = best;
        }
      }
    }
    return { ...q, lbl: out };
  }

  // ---- 配色プリセット ----
  // transform: Labの色を変換する / gradient: 明るさの順に色を割り当てる（元の色味を少し残す）
  const lerp = (a, b, t) => a + (b - a) * t;
  function sampleGradient(stops, t) {
    const pos = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    return [0, 1, 2].map((k) => lerp(stops[i][k], stops[i + 1][k], f));
  }

  const PALETTES = [
    { id: 'natural', name: 'ナチュラル', swatch: ['#3b5b8c', '#e8b796', '#f4f1ea'],
      transform: ([L, a, b]) => [L, a * 1.15, b * 1.15] },
    { id: 'pastel', name: 'パステル', swatch: ['#f7b8c8', '#b9d8f2', '#fdf3c4'],
      transform: ([L, a, b]) => [55 + L * 0.42, a * 0.6, b * 0.6] },
    { id: 'yumekawa', name: 'ゆめかわ', swatch: ['#b79be8', '#ffa8d2', '#b8f0e0'],
      gradient: [[45, 30, -40], [68, 42, -8], [82, 30, -2], [90, -18, 4], [97, 2, 8]], keep: 0.25 },
    { id: 'kusumi', name: 'くすみ', swatch: ['#8e8a9c', '#c4a9a3', '#d9d2c1'],
      transform: ([L, a, b]) => [30 + L * 0.55, a * 0.45, b * 0.45 + 3] },
    { id: 'milktea', name: 'ミルクティー', swatch: ['#6b4f3f', '#c8a383', '#f3e6d4'],
      gradient: [[28, 8, 14], [48, 10, 20], [68, 8, 20], [84, 4, 14], [95, 1, 7]], keep: 0.15 },
    { id: 'soda', name: 'ソーダ', swatch: ['#2f6fb8', '#7fd3f0', '#e6fbff'],
      gradient: [[30, 6, -45], [52, -8, -38], [72, -22, -18], [88, -18, -4], [98, -4, -2]], keep: 0.15 },
    { id: 'mono', name: 'モノクロ', swatch: ['#2b2b2b', '#8c8c8c', '#f2f2f2'],
      gradient: [[15, 0, 0], [45, 0, 0], [72, 0, 0], [95, 0, 0]], keep: 0, steps: 4 },
  ];

  function paletteColors(cent, palette) {
    if (palette.transform) return cent.map(palette.transform);
    const Ls = cent.map((c) => c[0]);
    const min = Math.min(...Ls), max = Math.max(...Ls);
    return cent.map(([L, a, b]) => {
      let t = max > min ? (L - min) / (max - min) : 0.5;
      if (palette.steps) t = Math.round(t * (palette.steps - 1)) / (palette.steps - 1);
      const g = sampleGradient(palette.gradient, t);
      return [g[0], g[1] + a * palette.keep, g[2] + b * palette.keep];
    });
  }

  // ---- 4. 描画（境目の線つき） ----
  // lineMode: 'luma' = 明るさの差が大きい境目だけ / 'edge' = 色が大きく違う境目すべて
  // lineDark: 線の濃さ（大きいほど黒に近い） / contrast: 明暗の差を広げる倍率
  function render(q, { paletteId = 'natural', lines = true, lineMode = 'luma', lineThreshold = 14, lineDark = 38, contrast = 1 } = {}) {
    const { W, H, lbl } = q;
    let { cent } = q;
    if (contrast !== 1) {
      const mean = cent.reduce((s, c) => s + c[0], 0) / cent.length;
      cent = cent.map(([L, a, b]) => [Math.max(0, Math.min(100, mean + (L - mean) * contrast)), a, b]);
    }
    const palette = PALETTES.find((p) => p.id === paletteId) || PALETTES[0];
    const labs = paletteColors(cent, palette);
    const fill = labs.map(([L, a, b]) => lab2rgb(L, a, b));
    // 線は真っ黒ではなく、その色を濃くしたもの（やわらかい印象にする）
    const line = labs.map(([L, a, b]) => lab2rgb(Math.max(8, L - lineDark), a * 0.9, b * 0.9));
    const labDist = (i, j) => Math.hypot(cent[i][0] - cent[j][0], cent[i][1] - cent[j][1], cent[i][2] - cent[j][2]);
    const isLine = (me, nb) => {
      if (nb === me) return false;
      if (lineMode === 'edge') {
        // 1ドット幅にするため、暗い側（同じ明るさなら番号の小さい側）だけに線を引く
        const darker = cent[me][0] < cent[nb][0] || (cent[me][0] === cent[nb][0] && me < nb);
        return darker && labDist(me, nb) > lineThreshold;
      }
      // 明るさの差が大きい境目の、暗い側に線を入れる。
      // ただし同じ色の濃淡（肌の陰影など）には引かない：色味(a,b)も違うか、明るさが大きく違うときだけ
      const dL = cent[nb][0] - cent[me][0];
      if (dL <= lineThreshold) return false;
      const dAB = Math.hypot(cent[me][1] - cent[nb][1], cent[me][2] - cent[nb][2]);
      return dAB > 10 || dL > 40;
    };
    const out = makeCanvas(W, H);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const me = lbl[y * W + x];
        let c = fill[me];
        if (lines) {
          for (const [dx, dy] of dirs) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            if (isLine(me, lbl[yy * W + xx])) {
              c = line[me];
              break;
            }
          }
        }
        const k = (y * W + x) * 4;
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // 写真（作業用キャンバス）から、長辺 dots ドットの「色まとめ済みデータ」を作る
  // smooth: 陰影を平らにする強さ / passes: 浮いたドットを掃除する回数
  function analyze(work, dots, { colors = 16, smooth = 2, passes = 1 } = {}) {
    const w = work.width, h = work.height;
    const gw = w >= h ? dots : Math.max(1, Math.round(dots * w / h));
    const gh = w >= h ? Math.max(1, Math.round(dots * h / w)) : dots;
    const flat = smooth > 0 ? kuwahara(scaleTo(work, gw * 3, gh * 3), smooth) : work;
    let q = quantize(scaleTo(flat, gw, gh), colors);
    for (let i = 0; i < passes; i++) q = cleanup(q);
    return q;
  }

  return { PALETTES, analyze, render };
})();
