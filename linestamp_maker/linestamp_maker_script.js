"use strict";

/* =====================================================================
   ラインスタンプメーカー

   設計方針：
     ・機能ひとつを 1 クラスにまとめ、読みやすく／足しやすく。
     ・アプリ本体（PaintApp）は個々の道具の中身を知らない。
       道具は共通の「約束（onStart / onMove / onEnd）」を満たすだけ。
       → 道具を増やしても PaintApp は書き換えなくてよい（開放／閉鎖）。
     ・塗りつぶしはピクセル単位の処理なので、undo/redo と保存は
       「描画結果そのもの（ビットマップ）」を記録する方式で統一する。
   ===================================================================== */


/* ---------------------------------------------------------------------
   色ユーティリティ：HSL を #rrggbb に変換する
   --------------------------------------------------------------------- */
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = x => Math.round(255 * x).toString(16).padStart(2, "0");
  return "#" + to255(f(0)) + to255(f(8)) + to255(f(4));
}

// 48色をつくる（グレースケール 8 ＋ 有彩色 8色相 × 5明度 = 40）
function buildColors() {
  const colors = [];
  const grayCount = 8;
  for (let i = 0; i < grayCount; i++) {
    const v = Math.round(255 * i / (grayCount - 1)).toString(16).padStart(2, "0");
    colors.push("#" + v + v + v);
  }
  const hues   = [0, 30, 55, 120, 175, 210, 265, 310]; // 8色相
  const lights = [82, 66, 50, 36, 24];                 // 5明度（明→暗）
  for (const l of lights) {
    for (const h of hues) {
      colors.push(hslToHex(h, 78, l));
    }
  }
  return colors; // 8 + 40 = 48色
}


/* ---------------------------------------------------------------------
   Tool（基底クラス）：すべての道具が守る「約束」を定義する
     onStart(ctx, point, style) … 押した瞬間
     onMove (ctx, point, style) … 押しながら動かした時
     onEnd  (ctx, point, style) … 離した瞬間
   style = { color, width } を受け取る。
   --------------------------------------------------------------------- */
class Tool {
  onStart(ctx, point, style) {}
  onMove(ctx, point, style)  {}
  onEnd(ctx, point, style)   {}
}

/* StrokeTool：手書き系（ペン・消しゴム）の共通処理。
   ペンと消しゴムの違いは「合成方法」だけなので、そこだけ差し替える。 */
class StrokeTool extends Tool {
  constructor(compositeOperation) {
    super();
    this.composite = compositeOperation;
    this.last = null;
  }
  onStart(ctx, point, style) {
    ctx.save();
    ctx.globalCompositeOperation = this.composite;
    ctx.lineCap  = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth   = style.width;
    ctx.strokeStyle = style.color;
    ctx.fillStyle   = style.color;
    // 1 点だけ押した時も丸い点が残るように、まず円を打つ
    ctx.beginPath();
    ctx.arc(point.x, point.y, style.width / 2, 0, Math.PI * 2);
    ctx.fill();
    this.last = point;
  }
  onMove(ctx, point) {
    ctx.beginPath();
    ctx.moveTo(this.last.x, this.last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    this.last = point;
  }
  onEnd(ctx) {
    ctx.restore(); // save() で退避した合成設定などを元に戻す
    this.last = null;
  }
}

// ペン：ふつうに上描きする
class PenTool extends StrokeTool {
  constructor() { super("source-over"); }
}

// 消しゴム：描いてある部分を「透明」に削る
class EraserTool extends StrokeTool {
  constructor() { super("destination-out"); }
}

/* FillTool：塗りつぶし（フラッドフィル）。
   押した点と同じ色の、地続きの領域を選んだ色で塗る。 */
class FillTool extends Tool {
  onStart(ctx, point, style) {
    const { width, height } = ctx.canvas;
    const image = ctx.getImageData(0, 0, width, height);
    const data  = image.data;

    const startIndex = (point.y * width + point.x) * 4;
    const start = [
      data[startIndex], data[startIndex + 1],
      data[startIndex + 2], data[startIndex + 3],
    ];
    const target = FillTool.hexToRgba(style.color);

    // すでに同じ色なら何もしない（無限ループ防止も兼ねる）
    if (FillTool.isSame(start, target, 0)) return;

    const tolerance = 32; // ふちのにじみ（アンチエイリアス）を吸収する許容差
    const stack = [[point.x, point.y]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const i = (y * width + x) * 4;
      const here = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (!FillTool.isSame(here, start, tolerance)) continue;

      data[i]     = target[0];
      data[i + 1] = target[1];
      data[i + 2] = target[2];
      data[i + 3] = target[3];

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ctx.putImageData(image, 0, 0);
  }

  // "#rrggbb" → [r, g, b, 255]
  static hexToRgba(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      255,
    ];
  }
  // 2 色が許容差の範囲で同じか
  static isSame(a, b, tolerance) {
    return Math.abs(a[0] - b[0]) <= tolerance
        && Math.abs(a[1] - b[1]) <= tolerance
        && Math.abs(a[2] - b[2]) <= tolerance
        && Math.abs(a[3] - b[3]) <= tolerance;
  }
}


/* ---------------------------------------------------------------------
   History：undo / redo。描画結果（ImageData）を 1 手ごとに記録する。
   --------------------------------------------------------------------- */
class History {
  constructor(limit = 40) {
    this.stack = [];
    this.index = -1;
    this.limit = limit;
  }
  push(snapshot) {
    // 「戻る」した後に描いたら、それ以降のやり直し履歴は捨てる
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }
  undo() { return this.canUndo ? this.stack[--this.index] : null; }
  redo() { return this.canRedo ? this.stack[++this.index] : null; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
}


/* ---------------------------------------------------------------------
   Storage：描きかけの保存／呼び出し（ブラウザの localStorage を使う）
   --------------------------------------------------------------------- */
class Storage {
  constructor(key = "line-stamp-maker") { this.key = key; }
  save(dataUrl) {
    try { localStorage.setItem(this.key, dataUrl); return true; }
    catch (e) { return false; } // プレビュー環境などで使えない場合
  }
  load() {
    try { return localStorage.getItem(this.key); }
    catch (e) { return null; }
  }
}


/* ---------------------------------------------------------------------
   Palette：48色のスウォッチを並べ、選択を通知する
   --------------------------------------------------------------------- */
class Palette {
  constructor(container, colors, onSelect) {
    this.onSelect = onSelect;
    this.buttons = colors.map(color => {
      const btn = document.createElement("button");
      btn.className = "swatch";
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener("click", () => this.select(color, btn));
      container.appendChild(btn);
      return { color, btn };
    });
  }
  select(color, btn) {
    this.buttons.forEach(b => b.btn.classList.toggle("selected", b.btn === btn));
    this.onSelect(color);
  }
  selectColor(color) {
    const found = this.buttons.find(b => b.color === color);
    if (found) this.select(color, found.btn);
  }
}


/* ---------------------------------------------------------------------
   PaintApp：全体をまとめる本体。
   道具は registry（名前→道具）で持ち、共通の約束で呼び出すだけ。
   --------------------------------------------------------------------- */
class PaintApp {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d", { willReadFrequently: true });

    // 現在の状態
    this.style = { color: "#000000", width: 8 };
    this.currentTool = "pen";
    this.drawing = false;

    // 道具の登録（増やしたい時はここに 1 行足すだけ）
    this.tools = {
      pen:    new PenTool(),
      eraser: new EraserTool(),
      fill:   new FillTool(),
    };

    this.history = new History();
    this.storage = new Storage();

    this.bindPointer();
    this.commit(); // まっさらな状態を履歴の最初に入れておく
  }

  get tool() { return this.tools[this.currentTool]; }

  // 画面上の座標をキャンバス内のピクセル座標へ変換する
  toPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: Math.floor((event.clientX - rect.left) * scaleX),
      y: Math.floor((event.clientY - rect.top)  * scaleY),
    };
  }

  bindPointer() {

    this.canvas.style.touchAction = "none"; // スクロールやズームを無効化する

    this.canvas.addEventListener("contextmenu", e => e.preventDefault());

    this.canvas.addEventListener("pointerdown", e => {
      this.drawing = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.tool.onStart(this.ctx, this.toPoint(e), this.style);
    });
    this.canvas.addEventListener("pointermove", e => {
      if (!this.drawing) return;
      this.tool.onMove(this.ctx, this.toPoint(e), this.style);
    });
    const finish = e => {
      if (!this.drawing) return;
      this.drawing = false;
      this.tool.onEnd(this.ctx, this.toPoint(e), this.style);
      this.commit(); // 1 手終わったので履歴に記録
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
  }

  // --- 状態の変更 ---
  setTool(name)  { this.currentTool = name; }
  setColor(color){ this.style.color = color; }
  setWidth(width){ this.style.width = width; }

  // --- 履歴 ---
  commit() {
    const snap = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.history.push(snap);
    this.onHistoryChange();
  }
  restore(snapshot) {
    if (snapshot) this.ctx.putImageData(snapshot, 0, 0);
    this.onHistoryChange();
  }
  undo() { this.restore(this.history.undo()); }
  redo() { this.restore(this.history.redo()); }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.commit();
  }

  // --- ファイル ---
  save() {
    return this.storage.save(this.canvas.toDataURL("image/png"));
  }

  // データURL（保存データ・読み込んだファイル共通）を画像として描き込む
  drawImageFromUrl(url) {
    const img = new Image();
    img.onload = () => {
      const cw = this.canvas.width, ch = this.canvas.height;
      this.ctx.clearRect(0, 0, cw, ch);
      // はみ出さないよう縦横比を保ち、中央に収めて描く
      const scale = Math.min(cw / img.width, ch / img.height);
      const w = img.width * scale, h = img.height * scale;
      this.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      this.commit();
    };
    img.onerror = () => alert("画像を読み込めませんでした。");
    img.src = url;
  }

  // ブラウザに保存した描きかけを呼び出す
  load() {
    const dataUrl = this.storage.load();
    if (!dataUrl) return false;
    this.drawImageFromUrl(dataUrl);
    return true;
  }

  // パソコンの画像ファイルを読み込む
  loadFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.drawImageFromUrl(reader.result);
    reader.readAsDataURL(file);
  }

  download(filename = "line-stamp.png") {
    this.canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  // undo/redo ボタンの有効・無効を外へ知らせるためのフック
  onHistoryChange() {}
}


/* =====================================================================
    Entory point：
   「画面（HTML）と PaintApp をつなぐ配線」
   ===================================================================== */
(() => {
  const app = new PaintApp(document.querySelector("canvas"));

  // --- ツール選択 ---
  const toolButtons = [...document.querySelectorAll("#tools .tool-btn")];
  function selectTool(name) {
    app.setTool(name);
    toolButtons.forEach(b => b.classList.toggle("selected", b.dataset.tool === name));
  }
  toolButtons.forEach(b => b.addEventListener("click", () => selectTool(b.dataset.tool)));

  // --- 太さ選択（5種類）---
  const WIDTHS = [2, 4, 6, 8, 10];
  const widthsBox = document.getElementById("widths");
  const widthButtons = WIDTHS.map(w => {
    const btn = document.createElement("button");
    btn.className = "width-btn";
    const dot = document.createElement("span");
    dot.className = "dot";
    const size = Math.min(w, 26);
    dot.style.width = size + "px";
    dot.style.height = size + "px";
    btn.appendChild(dot);
    btn.addEventListener("click", () => selectWidth(w, btn));
    widthsBox.appendChild(btn);
    return { w, btn };
  });
  function selectWidth(w, btn) {
    app.setWidth(w);
    widthButtons.forEach(x => x.btn.classList.toggle("selected", x.btn === btn));
  }

  // --- 色パレット（48色）---
  const chip = document.getElementById("currentChip");
  const colorText = document.getElementById("currentColorText");
  const palette = new Palette(
    document.getElementById("palette"),
    buildColors(),
    color => {
      app.setColor(color);
      chip.style.background = color;
      colorText.textContent = color;
    }
  );

  // --- 編集ボタン ---
  const undoBtn = document.getElementById("undo");
  const redoBtn = document.getElementById("redo");
  app.onHistoryChange = () => {
    undoBtn.disabled = !app.history.canUndo;
    redoBtn.disabled = !app.history.canRedo;
  };
  undoBtn.addEventListener("click", () => app.undo());
  redoBtn.addEventListener("click", () => app.redo());
  document.getElementById("clear").addEventListener("click", () => app.clear());

  // --- ファイルボタン ---
  document.getElementById("save").addEventListener("click", () => {
    alert(app.save() ? "保存しました。" : "この環境では保存できませんでした。");
  });
  document.getElementById("load").addEventListener("click", () => {
    if (!app.load()) alert("保存された画像がありません。");
  });
  document.getElementById("download").addEventListener("click", () => app.download());

  // 「画像を開く」→ 隠しファイル入力を開き、選ばれた画像を読み込む
  const fileInput = document.getElementById("fileInput");
  document.getElementById("open").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    app.loadFromFile(fileInput.files[0]);
    fileInput.value = ""; // 同じファイルを続けて選び直せるようにリセット
  });

  // --- 初期値をそろえる ---
  selectTool("pen");
  selectWidth(WIDTHS[2], widthButtons[2].btn);
  palette.selectColor("#000000");
  app.onHistoryChange();
})();