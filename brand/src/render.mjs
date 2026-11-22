// Renders the Forge brand files (PNG) from HTML with headless Chrome or Edge.
// Usage: node brand/src/render.mjs   (needs internet for the Archivo/Geist fonts)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..");
const inner = readFileSync(path.join(here, "mark-inner.txt"), "utf8").trim();
const LIME = "#d4ff2a";
const BG = "#080808";

const browser = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));
if (!browser) throw new Error("Chrome or Edge not found");

const mark = (color, attrs = "") =>
  `<svg ${attrs} viewBox="182 178 376 376" fill="none" stroke="${color}" stroke-width="36" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const head = (w, h, bg) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Geist:wght@400;500;600&family=Geist+Mono:wght@500&display=block" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg}}
body{font-family:Geist,sans-serif;color:#f4f4f0;-webkit-font-smoothing:antialiased}
.word{font-family:Archivo,sans-serif;font-stretch:125%;font-weight:800;letter-spacing:.02em;line-height:1}
</style></head><body>`;

/** Mark + FORGE side by side. `scale` is the mark height in px. */
const lockup = (scale, color, wordColor) => `
<div style="display:flex;align-items:center;gap:${scale * 0.34}px">
  ${mark(color, `width="${scale}" height="${scale}"`)}
  <span class="word" style="font-size:${scale * 0.62}px;color:${wordColor}">FORGE</span>
</div>`;

const pages = {
  // Full logo, horizontal, on the site's black.
  "forge-logo-full-dark.png": [2400, 800, `${head(2400, 800, BG)}
    <div style="height:100%;display:grid;place-items:center">${lockup(360, LIME, "#f4f4f0")}</div>`],
  // Full logo on transparent, for light or photo backgrounds pick the right colour.
  "forge-logo-full-lime-transparent.png": [2400, 800, `${head(2400, 800, "transparent")}
    <div style="height:100%;display:grid;place-items:center">${lockup(360, LIME, LIME)}</div>`],
  "forge-logo-full-black-transparent.png": [2400, 800, `${head(2400, 800, "transparent")}
    <div style="height:100%;display:grid;place-items:center">${lockup(360, BG, BG)}</div>`],
  // Stacked: mark over wordmark.
  "forge-logo-stacked-dark.png": [1600, 1600, `${head(1600, 1600, BG)}
    <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:90px">
      ${mark(LIME, 'width="760" height="760"')}
      <span class="word" style="font-size:220px">FORGE</span>
    </div>`],
  // Mark alone.
  "forge-mark-1024.png": [1024, 1024, `${head(1024, 1024, "transparent")}
    <div style="height:100%;display:grid;place-items:center">${mark(LIME, 'width="860" height="860"')}</div>`],
  // X / Telegram / Discord profile picture. X crops to a circle: the mark sits inside it.
  "forge-x-avatar-400.png": [400, 400, `${head(400, 400, BG)}
    <div style="height:100%;display:grid;place-items:center;background:radial-gradient(circle at 50% 42%,rgba(212,255,42,.16),transparent 62%)">
      ${mark(LIME, 'width="250" height="250"')}
    </div>`],
  // X header, 1500x500. Kept clear: bottom-left (the profile picture sits there) and the top/bottom
  // 60px (cropped on phones).
  "forge-x-banner-1500x500.png": [1500, 500, `${head(1500, 500, BG)}
    <div style="position:absolute;inset:0;background:
      radial-gradient(900px 520px at 88% 46%,rgba(212,255,42,.16),transparent 60%),
      radial-gradient(circle,rgba(255,255,255,.075) 1.2px,transparent 1.6px) 0 0/28px 28px"></div>
    <div style="position:absolute;inset:0;background:linear-gradient(90deg,${BG} 8%,rgba(8,8,8,.55) 45%,rgba(8,8,8,0) 70%)"></div>
    ${mark("rgba(212,255,42,.10)", 'width="760" height="760" style="position:absolute;right:-120px;top:-130px"')}
    <div style="position:absolute;left:430px;top:118px;width:660px">
      <div style="font-family:'Geist Mono',monospace;font-size:17px;letter-spacing:.16em;color:${LIME};margin-bottom:22px">PRIVATE OTC · ROBINHOOD CHAIN</div>
      <div class="word" style="font-size:64px;letter-spacing:0;line-height:1.02;font-stretch:112%">Trade size.<br><span style="color:${LIME}">Stay private.</span></div>
      <div style="font-size:21px;line-height:1.45;color:#b9b9b2;margin-top:24px;max-width:600px">Sealed-bid block trades for stock tokens. Settle both sides in one transaction.</div>
    </div>
    <div style="position:absolute;right:96px;top:50%;transform:translateY(-50%)">
      <div style="width:250px;height:250px;border-radius:50%;border:2px solid rgba(212,255,42,.55);display:grid;place-items:center;background:rgba(8,8,8,.7);box-shadow:0 0 80px rgba(212,255,42,.18)">
        ${mark(LIME, 'width="150" height="150"')}
      </div>
      <div class="word" style="font-size:38px;text-align:center;margin-top:22px">FORGE</div>
    </div>`],
};

const tmp = path.join(tmpdir(), "forge-brand");
mkdirSync(tmp, { recursive: true });
for (const [name, [w, h, html]] of Object.entries(pages)) {
  const file = path.join(tmp, name.replace(".png", ".html"));
  writeFileSync(file, `${html}</body></html>`);
  execFileSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--default-background-color=00000000", `--window-size=${w},${h}`, "--virtual-time-budget=8000",
    `--screenshot=${path.join(tmp, name)}`, pathToFileURL(file).href,
  ], { stdio: "ignore" });
  copyFileSync(path.join(tmp, name), path.join(out, name));
  console.log("wrote", name);
}
