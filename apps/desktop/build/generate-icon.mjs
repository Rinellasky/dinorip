// Generates the DinoRip app icons from the checked-in Icon Composer mark.
//
// macOS 26+ (Tahoe / Liquid Glass): the system supplies the squircle shape,
// depth, shadow, and glass lighting at render time, so we ship FLAT layers and
// let the OS do the rest. We emit a `.icon` bundle (Icon Composer format):
//   icon.icon/
//     icon.json        -> app icon recipe exported from Icon Composer
//     Assets/green.svg -> dino mark layer, no baked effects
// electron-builder compiles this via `actool` (needs Xcode 26+) into Assets.car
// and auto-generates a legacy .icns fallback for older macOS.
//
// Windows/Linux don't do Liquid Glass, so they get a plain full-canvas raster
// (icon.png) — also used as the dev/runtime window icon.
//
// Run: node build/generate-icon.mjs
import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const BROWN = "#2E2A26"; // sRGB 0.18039, 0.16471, 0.14902
const MARK_SCALE = 1.33;
const MARK_SIZE = Math.round(512 * MARK_SCALE);
const ICON_DIR = path.join(DIR, "icon.icon");
const MARK_FILE = path.join(ICON_DIR, "Assets", "green.svg");

async function markPng(size = MARK_SIZE) {
  return sharp(MARK_FILE)
    .resize(size, size, { fit: "contain" })
    .png()
    .toBuffer();
}

async function png(file, background) {
  const mark = await markPng();
  const inset = Math.round((SIZE - MARK_SIZE) / 2);
  await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background
    }
  })
    .composite([{ input: mark, left: inset, top: inset }])
    .png()
    .toFile(path.join(DIR, file));
  console.log("Wrote", file);
}

// 1) macOS Liquid Glass .icon bundle.
fs.mkdirSync(path.join(ICON_DIR, "Assets"), { recursive: true });
if (!fs.existsSync(MARK_FILE)) {
  throw new Error(`Missing ${path.relative(DIR, MARK_FILE)}. Copy the Icon Composer mark into build/icon.icon/Assets first.`);
}

const iconJson = {
  fill: { "automatic-gradient": "display-p3:0.17810,0.16711,0.15479,1.00000" },
  groups: [
    {
      layers: [],
      shadow: { kind: "neutral", opacity: 0.6 },
      translucency: { enabled: true, value: 0.2 }
    },
    {
      layers: [{
        "blend-mode": "normal",
        fill: {
          "linear-gradient": [
            "display-p3:0.52157,0.61176,0.33725,1.00000",
            "srgb:0.47843,0.54902,0.35294,1.00000"
          ],
          orientation: {
            start: { x: 0.4999999999999999, y: 0.2598465306348067 },
            stop: { x: 0.5, y: 1 }
          }
        },
        glass: true,
        hidden: false,
        "image-name": "green.svg",
        name: "green",
        opacity: 1,
        position: {
          scale: MARK_SCALE,
          "translation-in-points": [0, 0]
        }
      }],
      shadow: { kind: "neutral", opacity: 0.6 },
      translucency: { enabled: true, value: 0.2 }
    }
  ],
  "supported-platforms": {
    circles: ["watchOS"],
    squares: "shared"
  }
};
fs.writeFileSync(path.join(ICON_DIR, "icon.json"), JSON.stringify(iconJson, null, 2) + "\n");
console.log("Wrote icon.icon/icon.json");

// 2) Flat raster for Windows / Linux + the legacy macOS .icns fallback.
await png("icon.png", BROWN);

// 3) Pre-rounded icon for the dev Dock / window icon. macOS does NOT
// auto-squircle a programmatically-set Dock icon (only a packaged app's bundle
// icon), so we bake the macOS look ourselves. Geometry is measured from real
// system icons (App Store / Notes / Helium .icns), which all use the SAME grid:
//   - shape: continuous-corner SUPERELLIPSE (n=5) sized to 80.5% of the canvas
//     (Apple's 824-on-1024 grid). The Dock scales the whole canvas into the
//     tile, so this ~9.8% gutter is what makes the icon the same size as its
//     neighbours. The gutter stays transparent (no baked outer shadow; the
//     Dock adds its own; a baked one fills the gutter and reads as a grey frame).
//   - background: flat brand brown with a thin warm rim light on the top edge.
const SQ_R = (SIZE * 0.805) / 2;

// Continuous-corner squircle as a sampled superellipse |x|^n + |y|^n = 1.
function superellipsePath(cx, cy, rx, ry, n = 5, steps = 720) {
  const sgn = (v) => (v < 0 ? -1 : 1);
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = cx + rx * sgn(ct) * Math.pow(Math.abs(ct), 2 / n);
    const y = cy + ry * sgn(st) * Math.pow(Math.abs(st), 2 / n);
    d += `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return d + "Z";
}

const C = SIZE / 2;
const SQ = superellipsePath(C, C, SQ_R, SQ_R);

function roundedSvg() {
  const rim = superellipsePath(C, C, SQ_R - 4, SQ_R - 4); // inset for top edge light

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    <defs>
      <!-- thin warm edge light so the squircle reads on dark backgrounds -->
      <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff7ea" stop-opacity="0.40"/>
        <stop offset="0.16" stop-color="#fff7ea" stop-opacity="0.07"/>
        <stop offset="0.36" stop-color="#fff7ea" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${SQ}" fill="${BROWN}"/>
    <path d="${rim}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  </svg>`;
}

const roundedMark = await markPng(MARK_SIZE);
const roundedInset = Math.round((SIZE - MARK_SIZE) / 2);
await sharp(Buffer.from(roundedSvg()))
  .composite([{ input: roundedMark, left: roundedInset, top: roundedInset }])
  .png()
  .toFile(path.join(DIR, "icon-rounded.png"));
console.log("Wrote icon-rounded.png");
