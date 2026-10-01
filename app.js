'use strict';

// 読み込んだ写真をいったん縮小しておく最大サイズ。
// 48MPなどの巨大な写真でもiPhoneのCanvasメモリ上限に引っかからないようにする。
const WORK_MAX = 1024;
// 保存する画像の長辺のおおよその目標サイズ（ドットを整数倍に拡大する）
const EXPORT_TARGET = 1024;

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const picker = $('picker');
const stage = $('stage');
const preview = $('preview');
const controls = $('controls');
const sizeRange = $('sizeRange');
const sizeValue = $('sizeValue');
const changeBtn = $('changeBtn');
const saveBtn = $('saveBtn');
const statusEl = $('status');
const fallback = $('fallback');
const fallbackImg = $('fallbackImg');

let workCanvas = null; // 縮小済みの元画像
let renderQueued = false;

function setStatus(msg) {
  statusEl.textContent = msg;
}

// 写真ファイルを読み込む。EXIFの向きは最近のSafari/Chromeが自動で反映する。
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像は読み込めませんでした'));
    };
    img.src = url;
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// 元画像を長辺WORK_MAX以下に縮小した作業用キャンバスを作る
function toWorkCanvas(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, WORK_MAX / Math.max(w, h));
  const c = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// 半分ずつ縮小してから目標サイズにする（一気に縮めるとガタつくため）
function downscale(src, tw, th) {
  let cur = src;
  while (cur.width / 2 >= tw && cur.height / 2 >= th) {
    const next = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const ctx = next.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  const out = makeCanvas(tw, th);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  return out;
}

// 長辺をドット数にしたサイズを返す
function gridSize(dots) {
  const w = workCanvas.width;
  const h = workCanvas.height;
  if (w >= h) {
    return { gw: dots, gh: Math.max(1, Math.round(dots * h / w)) };
  }
  return { gw: Math.max(1, Math.round(dots * w / h)), gh: dots };
}

// ドット絵（1ドット=1ピクセル）を作る
function pixelate() {
  const { gw, gh } = gridSize(Number(sizeRange.value));
  return downscale(workCanvas, gw, gh);
}

// ドット絵をにじませずに整数倍で拡大する
function upscale(src, factor) {
  const out = makeCanvas(src.width * factor, src.height * factor);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function render() {
  renderQueued = false;
  if (!workCanvas) return;
  const pixel = pixelate();
  preview.width = pixel.width;
  preview.height = pixel.height;
  const ctx = preview.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, pixel.width, pixel.height);
  ctx.drawImage(pixel, 0, 0);
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

async function handleFile(file) {
  if (!file) return;
  setStatus('読み込み中…');
  try {
    const { img, url } = await loadImage(file);
    workCanvas = toWorkCanvas(img);
    URL.revokeObjectURL(url);
    picker.hidden = true;
    preview.hidden = false;
    controls.hidden = false;
    fallback.hidden = true;
    stage.classList.add('has-image');
    render();
    setStatus('');
  } catch (err) {
    setStatus(err.message);
  } finally {
    fileInput.value = ''; // 同じ写真をもう一度選べるようにする
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png');
  });
}

function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `pixel-kawaii-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

async function save() {
  if (!workCanvas) return;
  saveBtn.disabled = true;
  setStatus('保存の準備中…');
  try {
    const pixel = pixelate();
    const factor = Math.max(1, Math.round(EXPORT_TARGET / Math.max(pixel.width, pixel.height)));
    const blob = await canvasToBlob(upscale(pixel, factor));
    const file = new File([blob], fileName(), { type: 'image/png' });

    // iPhoneでは共有シートから「画像を保存」やSNSへ送れる
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        setStatus('');
        return;
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus('');
          return;
        }
        // 共有に失敗したら下の方法にフォールバック
      }
    }

    const url = URL.createObjectURL(blob);
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      // 共有が使えないiPhoneでは長押し保存してもらう
      fallbackImg.src = url;
      fallback.hidden = false;
      fallback.scrollIntoView({ behavior: 'smooth' });
      setStatus('');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus('保存しました');
    }
  } catch (err) {
    setStatus(err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
changeBtn.addEventListener('click', () => fileInput.click());
sizeRange.addEventListener('input', () => {
  sizeValue.textContent = sizeRange.value;
  queueRender();
});
saveBtn.addEventListener('click', save);
$('closeFallback').addEventListener('click', () => {
  fallback.hidden = true;
  if (fallbackImg.src) URL.revokeObjectURL(fallbackImg.src);
  fallbackImg.removeAttribute('src');
});

// オフラインでも開けるようにする（https または localhost のときだけ動く）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
