import "@krill-software/desktop-ui/styles";
import "./styles.css";
import {
  mountChrome,
  showBootError,
  checkForUpdates,
} from "@krill-software/desktop-ui";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

// ---- Types ------------------------------------------------------------

interface OpenedImage {
  path: string;
  name: string;
  data_url: string;
}

interface AppState {
  window?: { width: number; height: number; x: number; y: number };
  recent?: string[];
  color?: string;
  brush_size?: number;
}

type Tool =
  | "pencil"
  | "brush"
  | "eraser"
  | "line"
  | "rect"
  | "ellipse"
  | "fill"
  | "eyedropper";

// ---- Constants --------------------------------------------------------

const DEFAULT_W = 960;
const DEFAULT_H = 600;
const WHITE = "#ffffff";
const UNDO_MAX = 30;

// ---- DOM refs ---------------------------------------------------------

let viewportEl: HTMLElement;
let railEl: HTMLElement;
let titleLabelEl: HTMLElement;
let infoEl: HTMLElement;

let bitmap: HTMLCanvasElement; // the document
let overlay: HTMLCanvasElement; // live shape/line preview
let bctx: CanvasRenderingContext2D;
let octx: CanvasRenderingContext2D;

let colorWell: HTMLInputElement;
let sizeRange: HTMLInputElement;
let sizeLabel: HTMLElement;
let swatchRow: HTMLElement;
let undoBtn: HTMLButtonElement;
let redoBtn: HTMLButtonElement;

// ---- App state --------------------------------------------------------

let tool: Tool = "brush";
let color = "#30343f"; // Space Cadet to start — replaced from saved state
let brushSize = 6;
let recent: string[] = [];

let canvasName = "untitled.png";
let dirty = false;

// Undo/redo as full-canvas snapshots. cleanDepth tracks the undo depth at
// the last save so the dirty marker can clear on undo back to a saved state.
const undoStack: ImageData[] = [];
const redoStack: ImageData[] = [];
let cleanDepth = 0;

// ---- Color helpers ----------------------------------------------------

function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function rgbaToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---- Title / dirty ----------------------------------------------------

function updateDirty(): void {
  dirty = undoStack.length !== cleanDepth;
  paintTitle();
}

function markEdited(): void {
  // Called after committing an op; the snapshot was already pushed.
  redoStack.length = 0;
  updateDirty();
  refreshEditButtons();
}

function paintTitle(): void {
  // Title box is just the filename; the dirty bullet hangs to its right
  // via body[data-dirty] + a CSS ::after, matching desktop-ui's titlebar.
  titleLabelEl.textContent = canvasName;
  document.body.dataset.dirty = dirty ? "true" : "false";
  // The OS taskbar / window title is a separate surface — a leading
  // marker is the convention there.
  const t = `${dirty ? "• " : ""}${canvasName} — Paint`;
  document.title = t;
  getCurrentWindow().setTitle(t).catch(() => {});
}

// ---- Undo / redo ------------------------------------------------------

function snapshot(): ImageData {
  return bctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Capture the canvas state *before* an edit. Call right before the first
 *  pixel of an operation is written. */
function pushUndo(): void {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_MAX) {
    undoStack.shift();
    cleanDepth = Math.max(0, cleanDepth - 1);
  }
}

function applySnapshot(img: ImageData): void {
  if (img.width !== bitmap.width || img.height !== bitmap.height) {
    resizeCanvas(img.width, img.height);
  }
  bctx.putImageData(img, 0, 0);
}

function undo(): void {
  if (undoStack.length === 0) return;
  redoStack.push(snapshot());
  applySnapshot(undoStack.pop()!);
  updateDirty();
  refreshEditButtons();
}

function redo(): void {
  if (redoStack.length === 0) return;
  undoStack.push(snapshot());
  applySnapshot(redoStack.pop()!);
  updateDirty();
  refreshEditButtons();
}

function refreshEditButtons(): void {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// ---- Canvas lifecycle -------------------------------------------------

function resizeCanvas(w: number, h: number): void {
  bitmap.width = w;
  bitmap.height = h;
  bitmap.style.width = `${w}px`;
  bitmap.style.height = `${h}px`;
  overlay.width = w;
  overlay.height = h;
  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;
}

function newCanvas(w = DEFAULT_W, h = DEFAULT_H): void {
  if (!confirmDiscard()) return;
  resizeCanvas(w, h);
  bctx.fillStyle = WHITE;
  bctx.fillRect(0, 0, w, h);
  undoStack.length = 0;
  redoStack.length = 0;
  cleanDepth = 0;
  canvasName = "untitled.png";
  void invoke("clear_path").catch(() => {});
  updateDirty();
  refreshEditButtons();
  updateInfo();
}

function confirmDiscard(): boolean {
  if (!dirty) return true;
  return window.confirm("Discard unsaved changes?");
}

// ---- Open -------------------------------------------------------------

async function openPath(path: string): Promise<void> {
  if (!confirmDiscard()) return;
  let info: OpenedImage;
  try {
    info = await invoke<OpenedImage>("open_image", { path });
  } catch (e) {
    console.error("open_image failed:", e);
    return;
  }
  const img = new Image();
  img.onload = () => {
    resizeCanvas(img.naturalWidth || DEFAULT_W, img.naturalHeight || DEFAULT_H);
    bctx.fillStyle = WHITE;
    bctx.fillRect(0, 0, bitmap.width, bitmap.height);
    bctx.drawImage(img, 0, 0);
    undoStack.length = 0;
    redoStack.length = 0;
    cleanDepth = 0;
    canvasName = info.name;
    updateDirty();
    refreshEditButtons();
    updateInfo();
  };
  img.onerror = () => console.error("decode failed for", info.path);
  img.src = info.data_url;
}

async function openViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (typeof selected === "string") await openPath(selected);
}

// ---- Save -------------------------------------------------------------

async function save(): Promise<void> {
  const path = await invoke<string>("current_path");
  if (path) {
    await writePng(path);
  } else {
    await saveAs();
  }
}

async function saveAs(): Promise<void> {
  const base = canvasName.replace(/\.[^.]+$/, "");
  const chosen = await saveDialog({
    title: "Save PNG as…",
    defaultPath: `${base || "untitled"}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (typeof chosen !== "string") return;
  await writePng(chosen);
}

async function writePng(path: string): Promise<void> {
  const dataUrl = bitmap.toDataURL("image/png");
  try {
    const abs = await invoke<string>("save_png", { path, dataUrl });
    canvasName = basename(abs);
    cleanDepth = undoStack.length;
    updateDirty();
  } catch (e) {
    console.error("save_png failed:", e);
  }
}

// ---- Pointer → canvas coordinates -------------------------------------

interface Pt {
  x: number;
  y: number;
}

function pointFromEvent(e: PointerEvent): Pt {
  const rect = overlay.getBoundingClientRect();
  const sx = bitmap.width / rect.width;
  const sy = bitmap.height / rect.height;
  return {
    x: Math.floor((e.clientX - rect.left) * sx),
    y: Math.floor((e.clientY - rect.top) * sy),
  };
}

// ---- Drawing ----------------------------------------------------------

function strokeStyleFor(t: Tool): { color: string; width: number } {
  if (t === "eraser") return { color: WHITE, width: brushSize };
  if (t === "pencil") return { color, width: 1 };
  return { color, width: brushSize };
}

function beginFreehand(p: Pt, t: Tool): void {
  const s = strokeStyleFor(t);
  bctx.strokeStyle = s.color;
  bctx.fillStyle = s.color;
  bctx.lineWidth = s.width;
  bctx.lineCap = "round";
  bctx.lineJoin = "round";
  // A dot so a single click leaves a mark.
  bctx.beginPath();
  bctx.arc(p.x, p.y, Math.max(0.5, s.width / 2), 0, Math.PI * 2);
  bctx.fill();
  bctx.beginPath();
  bctx.moveTo(p.x, p.y);
}

function extendFreehand(p: Pt): void {
  bctx.lineTo(p.x, p.y);
  bctx.stroke();
  bctx.beginPath();
  bctx.moveTo(p.x, p.y);
}

function drawShapePreview(a: Pt, b: Pt, t: Tool): void {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.strokeStyle = color;
  octx.lineWidth = brushSize;
  octx.lineCap = "round";
  octx.lineJoin = "round";
  shapePath(octx, a, b, t);
  octx.stroke();
}

function commitShape(a: Pt, b: Pt, t: Tool): void {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  bctx.strokeStyle = color;
  bctx.lineWidth = brushSize;
  bctx.lineCap = "round";
  bctx.lineJoin = "round";
  shapePath(bctx, a, b, t);
  bctx.stroke();
}

function shapePath(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, t: Tool): void {
  ctx.beginPath();
  if (t === "line") {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else if (t === "rect") {
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (t === "ellipse") {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  }
}

// ---- Flood fill -------------------------------------------------------

function floodFill(start: Pt, fill: [number, number, number, number]): void {
  const w = bitmap.width;
  const h = bitmap.height;
  if (start.x < 0 || start.y < 0 || start.x >= w || start.y >= h) return;
  const imgData = bctx.getImageData(0, 0, w, h);
  const data = new Uint32Array(imgData.data.buffer);
  // Little-endian: 0xAABBGGRR
  const target = data[start.y * w + start.x];
  const repl =
    (fill[3] << 24) | (fill[2] << 16) | (fill[1] << 8) | fill[0];
  if (target === repl) return;

  const stack: number[] = [start.y * w + start.x];
  while (stack.length) {
    let idx = stack.pop()!;
    // Walk left to the run start.
    let x = idx % w;
    while (x > 0 && data[idx - 1] === target) {
      idx--;
      x--;
    }
    let spanUp = false;
    let spanDown = false;
    while (x < w && data[idx] === target) {
      data[idx] = repl;
      if (idx >= w) {
        const up = data[idx - w] === target;
        if (up && !spanUp) stack.push(idx - w);
        spanUp = up;
      }
      if (idx < (h - 1) * w) {
        const down = data[idx + w] === target;
        if (down && !spanDown) stack.push(idx + w);
        spanDown = down;
      }
      idx++;
      x++;
    }
  }
  bctx.putImageData(imgData, 0, 0);
}

// ---- Eyedropper -------------------------------------------------------

function pickColor(p: Pt): void {
  const d = bctx.getImageData(p.x, p.y, 1, 1).data;
  setColor(rgbaToHex(d[0], d[1], d[2]));
}

// ---- Pointer handling -------------------------------------------------

let drawing = false;
let shapeStart: Pt | null = null;

function installPointer(): void {
  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    overlay.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);

    if (tool === "eyedropper") {
      pickColor(p);
      return;
    }
    if (tool === "fill") {
      pushUndo();
      floodFill(p, hexToRgba(color));
      markEdited();
      return;
    }
    if (tool === "line" || tool === "rect" || tool === "ellipse") {
      pushUndo();
      shapeStart = p;
      drawing = true;
      return;
    }
    // freehand
    pushUndo();
    drawing = true;
    beginFreehand(p, tool);
  });

  overlay.addEventListener("pointermove", (e) => {
    const p = pointFromEvent(e);
    updateInfo(p);
    if (!drawing) return;
    if (shapeStart) {
      drawShapePreview(shapeStart, p, tool);
    } else {
      extendFreehand(p);
    }
  });

  const finish = (e: PointerEvent) => {
    if (!drawing) return;
    const p = pointFromEvent(e);
    if (shapeStart) {
      commitShape(shapeStart, p, tool);
      shapeStart = null;
    }
    drawing = false;
    markEdited();
  };
  overlay.addEventListener("pointerup", finish);
  overlay.addEventListener("pointercancel", finish);
  overlay.addEventListener("pointerleave", () => updateInfo());
}

// ---- Info line --------------------------------------------------------

function updateInfo(p?: Pt): void {
  const pos = p ? ` · ${p.x}, ${p.y}` : "";
  infoEl.textContent = `${bitmap.width} × ${bitmap.height}${pos} · 100%`;
}

// ---- Color / size setters --------------------------------------------

function setColor(hex: string): void {
  color = hex.toLowerCase();
  if (colorWell) colorWell.value = color;
  addRecent(color);
  void persist();
}

function setBrushSize(px: number): void {
  brushSize = Math.max(1, Math.min(64, Math.round(px)));
  if (sizeRange) sizeRange.value = String(brushSize);
  if (sizeLabel) sizeLabel.textContent = `${brushSize}px`;
  void persist();
}

function addRecent(hex: string): void {
  recent = [hex, ...recent.filter((c) => c !== hex)].slice(0, 8);
  paintSwatches();
}

function paintSwatches(): void {
  if (!swatchRow) return;
  swatchRow.replaceChildren();
  for (const c of recent) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.style.background = c; // content color, not chrome
    sw.title = c;
    sw.addEventListener("click", () => setColor(c));
    swatchRow.appendChild(sw);
  }
}

// ---- Tool selection ---------------------------------------------------

function setTool(t: Tool): void {
  tool = t;
  for (const btn of railEl.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    btn.dataset.active = btn.dataset.tool === t ? "true" : "false";
  }
  overlay.dataset.tool = t;
}

// ---- State persistence ------------------------------------------------

let persistRaf = 0;
function persist(): void {
  if (persistRaf) cancelAnimationFrame(persistRaf);
  persistRaf = requestAnimationFrame(() => {
    persistRaf = 0;
    const state: AppState = { color, brush_size: brushSize, recent };
    void invoke("save_state", { state }).catch(() => {});
  });
}

// ---- Rail -------------------------------------------------------------

const TOOLS: Array<{ tool: Tool; label: string; icon: string; key: string }> = [
  { tool: "pencil", label: "Pencil", icon: "pencil", key: "P" },
  { tool: "brush", label: "Brush", icon: "brush", key: "B" },
  { tool: "eraser", label: "Eraser", icon: "eraser", key: "E" },
  { tool: "line", label: "Line", icon: "line", key: "L" },
  { tool: "rect", label: "Rectangle", icon: "square", key: "R" },
  { tool: "ellipse", label: "Ellipse", icon: "circle", key: "O" },
  { tool: "fill", label: "Fill", icon: "bucket", key: "G" },
  { tool: "eyedropper", label: "Pick color", icon: "pipette", key: "I" },
];

function buildRail(): void {
  railEl.replaceChildren();
  railEl.appendChild(buildAuxTopbar());

  // Tools
  const tools = railBlock("Tools");
  for (const t of TOOLS) {
    const b = railBtnIcon(t.label, t.icon, () => setTool(t.tool));
    b.dataset.tool = t.tool;
    b.title = `${t.label} (${t.key})`;
    tools.appendChild(b);
  }
  railEl.appendChild(tools);

  // Color
  const colBlock = railBlock("Color");
  const well = document.createElement("input");
  well.type = "color";
  well.className = "color-well";
  well.value = color;
  well.addEventListener("input", () => setColor(well.value));
  colorWell = well;
  colBlock.appendChild(well);

  const sizeWrap = document.createElement("div");
  sizeWrap.className = "size-wrap";
  const sizeHdr = document.createElement("div");
  sizeHdr.className = "size-hdr";
  const sizeText = document.createElement("span");
  sizeText.textContent = "Size";
  sizeLabel = document.createElement("span");
  sizeLabel.className = "size-val mono";
  sizeLabel.textContent = `${brushSize}px`;
  sizeHdr.append(sizeText, sizeLabel);
  sizeRange = document.createElement("input");
  sizeRange.type = "range";
  sizeRange.min = "1";
  sizeRange.max = "64";
  sizeRange.value = String(brushSize);
  sizeRange.className = "size-range";
  sizeRange.addEventListener("input", () => setBrushSize(Number(sizeRange.value)));
  sizeWrap.append(sizeHdr, sizeRange);
  colBlock.appendChild(sizeWrap);

  swatchRow = document.createElement("div");
  swatchRow.className = "swatch-row";
  colBlock.appendChild(swatchRow);
  railEl.appendChild(colBlock);

  // Edit
  const editBlock = railBlock("Edit");
  undoBtn = railBtnIcon("Undo", "undo", () => undo());
  undoBtn.title = "Undo (Ctrl+Z)";
  redoBtn = railBtnIcon("Redo", "redo", () => redo());
  redoBtn.title = "Redo (Ctrl+Shift+Z)";
  const clearBtn = railBtnIcon("Clear", "trash", () => clearCanvas());
  clearBtn.title = "Clear canvas (Ctrl+Backspace)";
  editBlock.append(undoBtn, redoBtn, clearBtn);
  railEl.appendChild(editBlock);

  const hint = document.createElement("div");
  hint.className = "rail-hint";
  hint.textContent = "Drag to draw. Shapes commit on release. Pick a color off the canvas with the eyedropper.";
  railEl.appendChild(hint);

  paintSwatches();
  refreshEditButtons();
}

function clearCanvas(): void {
  pushUndo();
  bctx.fillStyle = WHITE;
  bctx.fillRect(0, 0, bitmap.width, bitmap.height);
  markEdited();
}

function railBlock(label: string): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "rail-block";
  const h = document.createElement("div");
  h.className = "rail-header";
  h.textContent = label;
  block.appendChild(h);
  return block;
}

function railBtnIcon(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rail-btn";
  b.append(svgIcon(icon, 14));
  const span = document.createElement("span");
  span.textContent = label;
  b.append(span);
  b.addEventListener("click", onClick);
  return b;
}

// ---- Shell topbars + hamburger ---------------------------------------

function buildMainTopbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "main-topbar";
  bar.setAttribute("data-tauri-drag-region", "true");

  titleLabelEl = document.createElement("div");
  titleLabelEl.className = "main-title";
  titleLabelEl.setAttribute("data-tauri-drag-region", "true");
  bar.appendChild(titleLabelEl);

  const controls = document.createElement("div");
  controls.className = "main-topbar-controls";
  const min = topbarBtn("Minimize", "minus", () => void getCurrentWindow().minimize());
  const max = topbarBtn("Maximize", "square", () => void getCurrentWindow().toggleMaximize());
  const close = topbarBtn("Close", "x", () => void getCurrentWindow().close());
  close.setAttribute("data-kind", "close");
  controls.append(min, max, close);
  bar.appendChild(controls);
  return bar;
}

function topbarBtn(title: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "main-topbar-btn";
  b.type = "button";
  b.title = title;
  b.append(svgIcon(icon, title === "Maximize" ? 12 : 14));
  b.addEventListener("click", onClick);
  return b;
}

function buildAuxTopbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "aux-topbar";
  bar.setAttribute("data-tauri-drag-region", "true");
  const hamburger = document.createElement("button");
  hamburger.className = "main-topbar-btn";
  hamburger.type = "button";
  hamburger.title = "Menu";
  hamburger.append(svgIcon("menu", 16));
  hamburger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHamburgerMenu(bar);
  });
  bar.appendChild(hamburger);
  return bar;
}

type MenuItem =
  | { label: string; shortcut?: string; action: () => void; enabled?: () => boolean }
  | { sep: true };

function toggleHamburgerMenu(anchor: HTMLElement): void {
  const existing = document.querySelector(".menu-popover");
  if (existing) {
    existing.remove();
    return;
  }
  const pop = document.createElement("div");
  pop.className = "menu-popover";
  const items: MenuItem[] = [
    { label: "New", shortcut: "Ctrl+N", action: () => newCanvas() },
    { label: "Open…", shortcut: "Ctrl+O", action: () => void openViaDialog() },
    { sep: true },
    { label: "Save", shortcut: "Ctrl+S", action: () => void save() },
    { label: "Save as…", shortcut: "Ctrl+Shift+S", action: () => void saveAs() },
    { sep: true },
    { label: "Undo", shortcut: "Ctrl+Z", action: () => undo(), enabled: () => undoStack.length > 0 },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", action: () => redo(), enabled: () => redoStack.length > 0 },
    { sep: true },
    { label: "Check for updates…", action: () => void checkForUpdates("Paint") },
    { label: "Quit", shortcut: "Ctrl+Q", action: () => void getCurrentWindow().close() },
  ];
  for (const it of items) {
    if ("sep" in it) {
      const s = document.createElement("div");
      s.className = "menu-popover-sep";
      pop.appendChild(s);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "menu-popover-item";
    btn.type = "button";
    const label = document.createElement("span");
    label.textContent = it.label;
    btn.appendChild(label);
    if (it.shortcut) {
      const k = document.createElement("span");
      k.className = "menu-popover-shortcut";
      k.textContent = it.shortcut;
      btn.appendChild(k);
    }
    if (it.enabled && !it.enabled()) btn.setAttribute("disabled", "");
    btn.addEventListener("click", () => {
      if (it.enabled && !it.enabled()) return;
      pop.remove();
      it.action();
    });
    pop.appendChild(btn);
  }
  anchor.parentElement?.appendChild(pop);
  setTimeout(() => {
    const handler = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener("click", handler);
      }
    };
    document.addEventListener("click", handler);
  }, 0);
}

// ---- Keyboard ---------------------------------------------------------

function installKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.code === "KeyN") { e.preventDefault(); newCanvas(); return; }
    if (mod && e.code === "KeyO") { e.preventDefault(); void openViaDialog(); return; }
    if (mod && e.code === "KeyS" && !e.shiftKey) { e.preventDefault(); void save(); return; }
    if (mod && e.code === "KeyS" && e.shiftKey) { e.preventDefault(); void saveAs(); return; }
    if (mod && e.code === "KeyZ" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && e.code === "KeyZ" && e.shiftKey) { e.preventDefault(); redo(); return; }
    if (mod && e.code === "Backspace") { e.preventDefault(); clearCanvas(); return; }
    if (mod) return; // leave other ctrl combos alone

    switch (e.code) {
      case "KeyP": setTool("pencil"); break;
      case "KeyB": setTool("brush"); break;
      case "KeyE": setTool("eraser"); break;
      case "KeyL": setTool("line"); break;
      case "KeyR": setTool("rect"); break;
      case "KeyO": setTool("ellipse"); break;
      case "KeyG": setTool("fill"); break;
      case "KeyI": setTool("eyedropper"); break;
      case "BracketLeft": setBrushSize(brushSize - 1); break;
      case "BracketRight": setBrushSize(brushSize + 1); break;
      default: return;
    }
    e.preventDefault();
  });
}

// ---- Drag-drop --------------------------------------------------------

async function installFileDrop(): Promise<void> {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path) await openPath(path);
    }
  });
}

// ---- Inline SVG icons -------------------------------------------------

/** Hand-rolled Lucide-style glyphs. Window controls use a 12×12 box /
 *  1.2 stroke (matches desktop-ui); everything else 24×24 / 1.8. */
function svgIcon(kind: string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const small = kind === "minus" || kind === "square-sm" || kind === "x" || kind === "menu";
  const isWinSquare = kind === "square" && size <= 12;
  const box = small || isWinSquare ? "0 0 12 12" : "0 0 24 24";
  svg.setAttribute("viewBox", box);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", small || isWinSquare ? "1.2" : "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");

  const paths: Record<string, string[]> = {
    minus: ["M2 6h8"],
    x: ["M3 3l6 6", "M9 3l-6 6"],
    menu: ["M2 3h8", "M2 6h8", "M2 9h8"],
    // square is dual-use: 12-box for the window control, 24-box for the rect tool
    square: isWinSquare ? ["M2.5 2.5h7v7H2.5z"] : ["M5 5h14v14H5z"],
    pencil: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
    brush: [
      "m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08",
      "M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z",
    ],
    eraser: [
      "m7 21-4.3-4.3a1.99 1.99 0 0 1 0-2.83l9.6-9.6a1.99 1.99 0 0 1 2.83 0l5.6 5.6a1.99 1.99 0 0 1 0 2.83L13 21",
      "M22 21H7",
      "m5 11 9 9",
    ],
    line: ["M5 19 19 5"],
    circle: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"],
    bucket: [
      "m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z",
      "m5 2 5 5",
      "M2 13h15",
      "M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z",
    ],
    pipette: [
      "m2 22 1-1h3l9-9",
      "M3 21v-3l9-9",
      "m15 6 3.4-3.4a2.12 2.12 0 1 1 3 3L18 9l.4.4a2.12 2.12 0 1 1-3 3L12 9",
    ],
    undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H10"],
    redo: ["m15 14 5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H14"],
    trash: [
      "M3 6h18",
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      "M10 11v6",
      "M14 11v6",
    ],
  };
  for (const d of paths[kind] ?? []) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ---- Init -------------------------------------------------------------

function initChrome(): void {
  const chrome = mountChrome({
    productName: "Paint",
    actions: {},
    showAuxPane: true,
    showStatusLine: false,
    updater: true,
  });
  viewportEl = chrome.viewport;
  railEl = chrome.aux!;
  railEl.setAttribute("aria-label", "Tools");

  const mainTopbar = buildMainTopbar();

  const content = document.createElement("div");
  content.className = "main-content";

  const scroll = document.createElement("div");
  scroll.id = "canvas-scroll";

  const stage = document.createElement("div");
  stage.id = "canvas-stage";
  bitmap = document.createElement("canvas");
  bitmap.id = "bitmap";
  overlay = document.createElement("canvas");
  overlay.id = "overlay";
  stage.append(bitmap, overlay);
  scroll.appendChild(stage);
  content.appendChild(scroll);

  infoEl = document.createElement("div");
  infoEl.id = "info-line";
  infoEl.className = "mono";
  content.appendChild(infoEl);

  viewportEl.replaceChildren(mainTopbar, content);

  bctx = bitmap.getContext("2d")!;
  octx = overlay.getContext("2d")!;

  buildRail();
  setTool(tool);

  document.body.dataset.aux = "visible";
}

async function boot(): Promise<void> {
  initChrome();
  installPointer();
  installKeyboard();
  await installFileDrop();

  // Restore last color / brush size / recents.
  try {
    const st = await invoke<AppState | null>("load_state");
    if (st?.color) color = st.color;
    if (typeof st?.brush_size === "number") brushSize = st.brush_size;
    if (Array.isArray(st?.recent)) recent = st.recent;
  } catch {
    /* first run */
  }
  setColor(color);
  setBrushSize(brushSize);

  // Start on a blank canvas, then let a CLI arg / dev fixture override.
  newCanvas();

  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch {
    /* cli plugin unavailable */
  }

  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch {
      /* no fixture */
    }
  }
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
