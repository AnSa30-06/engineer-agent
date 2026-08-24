/**
 * Verifies the desktop overlay really is a transparent, frameless sprite in the
 * bottom-right corner (sections 4, 21, 33).
 *
 * Why not a screenshot: a Chromium transparent window is composited through
 * DirectComposition, and neither GDI BitBlt nor Electron's desktopCapturer
 * samples that layer on Windows — both return the desktop as if the window were
 * not there. Measured, repeatedly. So the check goes through the window's own
 * rendered surface, alpha channel intact, which is what DWM actually blends
 * onto the desktop:
 *
 *   alpha 0   -> the desktop shows through (no window rectangle)
 *   alpha 255 -> the engineer is painted there
 *
 *   node tests/overlay.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SHOT = path.join(os.tmpdir(), 'engineer-overlay.png');

for (const f of [SHOT, `${SHOT}.json`]) if (fs.existsSync(f)) fs.unlinkSync(f);

console.log('launching the app with a self-capture seam…');
try {
  const electron = require('electron');   // resolves to the binary path in a plain node process
  execFileSync(electron, ['.'], {
    cwd: ROOT,
    env: { ...process.env, ENGINEER_SELF_TEST: SHOT },
    stdio: 'inherit',
    timeout: 120000,
  });
} catch { /* the app exits itself once the capture is written */ }

if (!fs.existsSync(SHOT)) { console.log('FAIL: the app produced no capture'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(`${SHOT}.json`, 'utf8'));

(async () => {
  const { data, info } = await sharp(SHOT).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  let clear = 0, opaque = 0;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * ch + 3];
      if (a < 8) clear++;
      else {
        opaque++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const total = W * H;
  const b = meta.bounds, area = meta.workArea;

  const rightEdge = b.x + b.width >= area.x + area.width - 40;
  const bottomEdge = b.y + b.height >= area.y + area.height - 40;
  const transparentRatio = clear / total;
  const paintedRatio = opaque / total;
  // the character must sit toward the bottom of his own window, not fill it
  const lowerHalf = maxY > H * 0.7;

  console.log(`capture             ${W}x${H}`);
  console.log(`window              ${b.x},${b.y} ${b.width}x${b.height} on work area ${area.width}x${area.height}`);
  console.log(`bottom-right corner ${rightEdge && bottomEdge ? 'yes' : 'NO'}`);
  console.log(`see-through         ${(transparentRatio * 100).toFixed(1)}% of the window is fully transparent`);
  console.log(`painted             ${(paintedRatio * 100).toFixed(1)}% carries the engineer`);
  console.log(`character bounds    x ${minX}-${maxX}, y ${minY}-${maxY}`);

  const checks = [
    ['sprite sits in the bottom-right corner', rightEdge && bottomEdge],
    ['most of the window is fully transparent (no window rectangle)', transparentRatio > 0.5],
    ['the engineer is actually painted', paintedRatio > 0.05],
    ['the engineer occupies only part of the window', paintedRatio < 0.75],
    ['the engineer sits at the bottom of the overlay', lowerHalf],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  fs.copyFileSync(SHOT, path.join(ROOT, 'overlay-check.png'));
  console.log(`\nsaved overlay-check.png\n${failed ? 'FAIL' : 'PASS'}: transparent desktop overlay`);
  process.exit(failed ? 1 : 0);
})();
