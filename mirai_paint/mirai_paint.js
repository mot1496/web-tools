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
     ・用紙サイズも一覧で持つ。増やす時は表を 1 行足すだけでよい。
   ===================================================================== */


/* ---------------------------------------------------------------------
   用紙サイズの一覧（増やしたい時はここに 1 行足すだけ）
     A4ヨコ = 297 × 210 mm を 96dpi 相当のピクセル数に直した値
   --------------------------------------------------------------------- */
const CANVAS_SIZES = {
  stamp: { label: "スタンプ", width:  370, height: 320 },
  a4:    { label: "A4ヨコ",   width: 1123, height: 794 },
};

// 画面に表示する大きさの上限（これを超える時だけ縮めて表示する）
const VIEW_LIMIT = { width: 560, height: 460 };


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

    // すでにまったく同じ色なら何もしない
    if (FillTool.isSame(start, target, 0)) return;

    const tolerance = 32; // ふちのにじみ（アンチエイリアス）を吸収する許容差
    // 調べ済みの画素を覚えておく。
    // これが無いと、塗った後の色が許容差の範囲で「元の色と同じ」と
    // 判定された時に同じ画素を何度も積み直し、終わらなくなる。
    const visited = new Uint8Array(width * height);
    const stack = [[point.x, point.y]];

    while (stack.length > 0) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const p = y * width + x;
      if (visited[p]) continue; // 一度調べた画素は二度と見ない
      visited[p] = 1;

      const i = p * 4;
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


/* MirrorTool：どんな道具にも「左右対称」を足す包み紙。
   自分では 1 本も線を引かない。中身の道具を 2 つ持ち、
   「押した点」と「縦の中心線で折り返した点」の両方に同じ操作をさせる。
   Tool と同じ約束（onStart/onMove/onEnd）を満たすので、
   PaintApp から見ればふつうの道具と区別がつかない。 */
class MirrorTool extends Tool {
  constructor(createTool) {
    super();
    // ペンなどは「直前の点」を自分で覚えているので、左右で別の実体にする
    this.left  = createTool();
    this.right = createTool();
  }
  // 縦の中心線で折り返した点（用紙サイズを変えても自動で追従する）
  static flip(ctx, point) {
    return { x: ctx.canvas.width - 1 - point.x, y: point.y };
  }
  onStart(ctx, point, style) {
    this.left.onStart(ctx, point, style);
    this.right.onStart(ctx, MirrorTool.flip(ctx, point), style);
  }
  onMove(ctx, point, style) {
    this.left.onMove(ctx, point, style);
    this.right.onMove(ctx, MirrorTool.flip(ctx, point), style);
  }
  onEnd(ctx, point, style) {
    // save() と restore() が入れ子になるので、後から始めた右側を先に終わらせる
    this.right.onEnd(ctx, MirrorTool.flip(ctx, point), style);
    this.left.onEnd(ctx, point, style);
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
    this.symmetry = false; // 左右対称モードかどうか
    this.drawing = false;
    this.activeTool = null; // いま描いている最中の道具

    // 道具の登録（増やしたい時はここに 1 行足すだけ）
    // 「実体」ではなく「作り方」を登録する。左右対称用にもう 1 組つくるため。
    const factories = {
      pen:    () => new PenTool(),
      eraser: () => new EraserTool(),
      fill:   () => new FillTool(),
    };
    this.tools       = {}; // ふつうに描く道具
    this.mirrorTools = {}; // 左右対称に描く道具（同じ約束を満たす包み紙）
    for (const [name, create] of Object.entries(factories)) {
      this.tools[name]       = create();
      this.mirrorTools[name] = new MirrorTool(create);
    }

    this.history = new History();
    this.storage = new Storage();

    this.applyViewSize();
    this.bindPointer();
    this.commit(); // まっさらな状態を履歴の最初に入れておく
  }

  get tool() {
    const registry = this.symmetry ? this.mirrorTools : this.tools;
    return registry[this.currentTool];
  }

  // 画面上の座標をキャンバス内のピクセル座標へ変換する
  // （表示を縮小していても、この比率計算がズレを吸収してくれる）
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
      // 描いている途中で道具や対称モードが切り替わっても
      // 同じ道具が最後まで面倒を見るよう、ここで決めておく
      this.activeTool = this.tool;
      this.canvas.setPointerCapture(e.pointerId);
      this.activeTool.onStart(this.ctx, this.toPoint(e), this.style);
    });
    this.canvas.addEventListener("pointermove", e => {
      if (!this.drawing) return;
      this.activeTool.onMove(this.ctx, this.toPoint(e), this.style);
    });
    const finish = e => {
      if (!this.drawing) return;
      this.drawing = false;
      this.activeTool.onEnd(this.ctx, this.toPoint(e), this.style);
      this.activeTool = null;
      this.commit(); // 1 手終わったので履歴に記録
    };
    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
  }

  // --- 状態の変更 ---
  setTool(name)  { this.currentTool = name; }
  setSymmetry(on){ this.symmetry = on; }
  setColor(color){ this.style.color = color; }
  setWidth(width){ this.style.width = width; }

  // --- 用紙サイズ ---
  /* キャンバスの幅・高さを変える。
     幅／高さを代入するとキャンバスの中身は消えるので、
     必要なら描いてある絵をいったん画像として退避してから描き戻す。 */
  setSize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;

    const keep = this.history.canUndo && confirm(
      "いま描いている絵を、新しいサイズに合わせて移しますか？\n" +
      "「キャンセル」を選ぶと白紙になります。");
    const dataUrl = keep ? this.canvas.toDataURL("image/png") : null;

    this.canvas.width  = width;   // ← ここでキャンバスの中身はまっさらになる
    this.canvas.height = height;
    this.applyViewSize();

    // 大きさの違う ImageData は混ぜられないので、履歴は作り直す
    this.history = new History();
    this.commit();

    // 移し替える時は拡大しない（小さい絵を引き伸ばしてぼやけさせない）
    if (dataUrl) this.drawImageFromUrl(dataUrl, false);
  }

  // 表示上の大きさを決める（上限を超える時だけ縮小して表示する）
  applyViewSize() {
    const scale = Math.min(1,
      VIEW_LIMIT.width  / this.canvas.width,
      VIEW_LIMIT.height / this.canvas.height);
    const wrap = this.canvas.parentElement;
    wrap.style.setProperty("--canvas-w", Math.round(this.canvas.width  * scale) + "px");
    wrap.style.setProperty("--canvas-h", Math.round(this.canvas.height * scale) + "px");
  }

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

  /* データURL（保存データ・読み込んだファイル共通）を画像として描き込む。
     enlarge = true  … キャンバスいっぱいまで拡大して収める
     enlarge = false … 小さい画像は原寸のまま中央に置く */
  drawImageFromUrl(url, enlarge = true) {
    const img = new Image();
    img.onload = () => {
      const cw = this.canvas.width, ch = this.canvas.height;
      this.ctx.clearRect(0, 0, cw, ch);
      // はみ出さないよう縦横比を保ち、中央に収めて描く
      let scale = Math.min(cw / img.width, ch / img.height);
      if (!enlarge) scale = Math.min(1, scale);
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

  // --- 用紙サイズ選択 ---
  const sizesBox = document.getElementById("sizes");
  const sizeText = document.getElementById("currentSizeText");
  const sizeButtons = Object.entries(CANVAS_SIZES).map(([key, size]) => {
    const btn = document.createElement("button");
    btn.className = "tool-btn";
    btn.textContent = size.label;
    btn.title = `${size.width} × ${size.height} px`;
    btn.addEventListener("click", () => selectSize(key, btn));
    sizesBox.appendChild(btn);
    return { key, btn };
  });
  function selectSize(key, btn) {
    const size = CANVAS_SIZES[key];
    app.setSize(size.width, size.height);
    sizeButtons.forEach(x => x.btn.classList.toggle("selected", x.btn === btn));
    sizeText.textContent = `${size.width} × ${size.height} px`;
  }

  // --- ツール選択 ---
  const toolButtons = [...document.querySelectorAll("#tools .tool-btn")];
  function selectTool(name) {
    app.setTool(name);
    toolButtons.forEach(b => b.classList.toggle("selected", b.dataset.tool === name));
  }
  toolButtons.forEach(b => b.addEventListener("click", () => selectTool(b.dataset.tool)));

  // --- 左右対称（縦の中心線で折り返して描く）---
  const symmetryBtn = document.getElementById("symmetry");
  const canvasWrap  = document.querySelector(".canvas-wrap");
  function setSymmetry(on) {
    app.setSymmetry(on);
    symmetryBtn.classList.toggle("selected", on);
    symmetryBtn.setAttribute("aria-pressed", String(on));
    canvasWrap.classList.toggle("symmetry", on); // 中心線の目安を表示する
  }
  symmetryBtn.addEventListener("click", () => setSymmetry(!app.symmetry));

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
  selectSize("stamp", sizeButtons[0].btn);
  selectTool("pen");
  setSymmetry(false);
  selectWidth(WIDTHS[2], widthButtons[2].btn);
  palette.selectColor("#000000");
  app.onHistoryChange();
})();
