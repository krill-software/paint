# Paint — Spec (v1)

A minimal, single-file Linux raster paint program. Open a blank canvas (or
an existing image), draw freehand with a brush, lay down lines / rectangles
/ ellipses, flood-fill regions, pick colors off the canvas, undo, save as
PNG. The bar is **MS Paint** — the calm, familiar 80%-of-the-job sketch
tool — not GIMP, not Krita, not a layered compositor.

## Identity

| Field | Value |
|---|---|
| Slug (directory) | `paint` |
| productName | `Paint` |
| Binary | `krill-paint` |
| Identifier | `software.krill.paint` |
| Lib name | `krill_paint_lib` |
| State dir | `$XDG_STATE_HOME/krill-paint/` |
| Repo | `krill-software/paint` |
| Document format | PNG (`.png`, `image/png`) |
| Icon glyph | Lucide `brush` on Shimmering Blush disc |

## Goals

- Open a blank canvas instantly on launch — there is always something to draw on.
- Cover the 80% of casual raster-drawing jobs: freehand strokes, straight
  lines, boxes, ellipses, flood fill, erase, color pick, undo, save.
- Open an existing raster image (PNG and whatever the system webview decodes
  — JPEG, WebP, GIF, BMP) and paint on top of it.
- Save / export as PNG. The canvas itself produces the bytes.
- Feel like a native Linux desktop app (`.desktop` entry, file associations,
  XDG dirs).
- Live, direct manipulation — what you see on the canvas *is* the document.

## Non-goals (v1)

- **No layers.** One canvas, one bitmap. (This is the single biggest line
  between "MS Paint" and "GIMP" — hold it.)
- No selection / move / transform of regions, no clipboard paste-as-layer.
- No filters, blend modes, adjustment curves, channels, masks.
- No vector objects — every shape commits to pixels the moment it's drawn.
- No text tool in v1 (stretch).
- No formats out other than PNG. No PDF/SVG export.
- No multi-tab / multi-window document management (one image per window).
- No Windows/macOS builds.
- No settings panel; no dark-mode toggle; no telemetry.

## Stack

- **Shell:** Tauri 2 (Rust backend + system webview).
- **Frontend:** TypeScript + Vite. The drawing surface is a single
  `<canvas>` 2D context — it owns every pixel.
- **Chrome + palette:** [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui)
  (git dep, pinned). Locked-palette CSS, custom titlebar, menu, status line
  via `mountChrome()`. We use the **shell-app layout** (see below).
- **Core helpers:** [`krill-desktop-core`](https://github.com/krill-software/desktop-core)
  (Cargo git dep). State I/O, file read, path canonicalization, IO error
  formatting, dev-fixture probe.

Rationale: the browser `<canvas>` already encodes and decodes PNG (and most
raster formats) natively. So the Rust side never touches an image codec — it
is a thin byte courier: read file bytes → hand the webview a `data:` URL on
open; take the canvas's `data:image/png;base64,…` string → decode and write
bytes on save. No `image` crate, no codec licensing, mirrors the krill
"heavy I/O in Rust is unnecessary when the platform already does it" instinct.

## Layout — the shell-app layout (shared with audio-editor)

This app uses the same chrome shape as **audio-editor** — the krill
"shell-app layout" (not yet a named export; candidate name: **shell chrome**).
Concretely:

- `mountChrome({ showAuxPane: true, showStatusLine: false })`. desktop-ui's
  default `#titlebar` and `#status-line` are hidden via CSS.
- **Main pane** (`#viewport`): a `.main-topbar` (drag region) carrying the
  window min / maximize / close buttons on the right, above a `.main-content`
  work area.
- **Aux pane** (`#aux`, the tool rail): an `.aux-topbar` (drag region) with a
  hamburger button that opens the File/Edit menu popover, above stacked
  `.rail-block` tool groups.
- **Work area:** the canvas, centered on a Ghost-White surface, displayed at
  100%, with a thin mono info line beneath it (canvas size · cursor x,y).

Paint is a **manipulation** app, so the tools live in the rail next to the
work, always visible — not hidden behind keyboard-only shortcuts.

## The canvas & color model

- **One bitmap.** New canvas defaults to **960 × 600**, filled pure white.
  (The canvas is *output*: pure `#FFFFFF` is correct here — an exported PNG
  must be true white, not Ghost White. The five-color palette governs app
  chrome, not document content.)
- **Foreground color.** A single active paint color, chosen via the rail's
  color well (`<input type="color">` → arbitrary RGB). A short strip of
  recent swatches sits beside it. The color the user paints with is content,
  not chrome — arbitrary RGB here does not violate the palette.
- **Brush size.** Rail slider, 1–64 px. Applies to brush / eraser / line /
  shape stroke width.
- **Canvas separation.** The white canvas is set apart from the near-white
  app background with a 1px Space-Cadet-alpha rule + soft shadow — the
  sanctioned palette technique, not a new grey fill.

## Tools (v1)

| Tool | Behavior | Key |
|---|---|---|
| **Pencil** | 1px hard freehand, ignores brush size | `B` then… (default tool) |
| **Brush** | Round freehand stroke at brush size | `B` |
| **Eraser** | Freehand paint in white at brush size | `E` |
| **Line** | Click-drag straight line, committed on release | `L` |
| **Rectangle** | Click-drag box outline (stroke) | `R` |
| **Ellipse** | Click-drag ellipse outline (stroke) | `O` |
| **Fill** | Flood-fill the contiguous region under the click | `G` |
| **Eyedropper** | Pick the pixel color under the click into foreground | `I` |

Shape/line tools draw a live preview on an overlay while dragging and commit
to the bitmap on mouse-up (so an in-flight drag is undo-free until released).

## Undo / redo

- Snapshot the canvas `ImageData` *before* each committed operation. `Ctrl+Z`
  restores the previous snapshot; `Ctrl+Shift+Z` re-applies.
- Capped at 30 levels (memory is the bound — a 960×600 RGBA snapshot is ~2.3 MB).
- Undo is **session-only**; once you save to disk, the file is the
  across-save undo.

## Save model

- **Save** (`Ctrl+S`): if the canvas was opened from / previously saved to a
  path, write PNG there. Otherwise behaves as Save As.
- **Save As** (`Ctrl+Shift+S`): dialog, default `untitled.png` (or
  `<name>-edit.png` when derived from an opened file).
- The canvas's `toDataURL("image/png")` produces the bytes; Rust decodes the
  base64 and writes them.
- **Dirty tracking:** any committed op since the last save marks the title
  dirty (`•` prefix); clears on successful save.
- New / Open with a dirty canvas prompts before discarding.

## File I/O

- **New** (`Ctrl+N`): blank 960×600 white canvas. (A size prompt is a stretch;
  v1 uses the default size.)
- **Open** (`Ctrl+O`): drag-drop, CLI arg, or dialog. Decoded by the webview
  via a `data:` URL from the Rust byte read; drawn onto the canvas. Canvas
  resizes to the image.
- **Save / Save As:** PNG only.

## Keybindings (v1)

| Action | Key |
|---|---|
| New | `Ctrl+N` |
| Open | `Ctrl+O` |
| Save / Save As | `Ctrl+S` / `Ctrl+Shift+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Pencil / Brush / Eraser | `P` / `B` / `E` |
| Line / Rectangle / Ellipse | `L` / `R` / `O` |
| Fill / Eyedropper | `G` / `I` |
| Clear canvas | `Ctrl+Backspace` |
| `[` / `]` | Decrease / increase brush size |
| Quit | `Ctrl+Q` |

## Window chrome

- Custom titlebar via the shell layout; filename centered (managed by the
  main-topbar drag region + `document.title`), dirty `•` prefix.
- **Aux rail:** Tools block, Color block (well + size slider + recent
  swatches), Edit block (undo / redo / clear). Hint line at the bottom.
- **No status line** (matches audio-editor's shell layout). Canvas size +
  cursor position are surfaced in the mono info line under the canvas.

## Linux integration

- Binary: `krill-paint`.
- `.desktop` MIME types: `image/png`.
- State: `$XDG_STATE_HOME/krill-paint/` — window geometry, recent files,
  last color + brush size.
- Distribution: AppImage primary; `.deb` secondary.

## Iconography

Shimmering Blush disc + a single Lucide glyph (`brush`) in Ghost White,
recorded in [`scripts/render-icons.py`](https://github.com/krill-software/.github/blob/main/scripts/render-icons.py)'s
`APPS` map as `"paint": "brush"`.

## Out of scope / open questions (for morning review)

- **Foreground + background color** (MS Paint's left/right-click model) —
  v1 is single foreground color. Likely worth adding.
- **Zoom / pan** — v1 is 100% only, scroll if the image overflows.
- **Text tool**, **filled** (vs. stroked) shapes, **rounded rect**,
  **polygon**, **spray/airbrush** — deferred.
- **Resize / crop canvas**, **New with size prompt** — deferred.
- Whether "Paint" is the right slug vs. `sketch` / `paint-editor`.

## Milestones

1. **M1 — Skeleton + draw + save.** *(this pass)* Shell-app layout; blank
   canvas on boot; pencil / brush / eraser / line / rect / ellipse / fill /
   eyedropper; foreground color + brush size; snapshot undo/redo; New / Open
   (PNG + webview-decodable rasters) / Save / Save As PNG; CLI arg + drag-drop
   open; canonical `brush` icon.
2. **M2 — Color & comfort.** Foreground/background colors, recent-swatch
   persistence, New-with-size prompt, canvas resize/crop, zoom.
3. **M3 — Packaging & site.** `docs/` landing page, org-site card, release via
   shared workflow. *(Paint is not graduated until the design bar is signed
   off — do not release before then.)*
