// Qiji brand generator — rounded-line mark (open Q + comet slash + spark dots)
// Style follows the previous brand: #6890F8, thick round-cap strokes, spark dots.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const BLUE = "#6890F8";
const C = Math.SQRT1_2;

// ---------- mark (design space; content bbox computed) ----------
const M = { cx: 232, cy: 232, r: 150, sw: 52, gapHalf: 0.48, slashIn: -60, slashOut: 255, dotTL: -240, dotTLr: 30, dotBR: 330, dotBRr: 24 };
function markContent() {
  const { cx, cy, r, sw, gapHalf, slashIn, slashOut, dotTL, dotTLr, dotBR, dotBRr } = M;
  const a0 = Math.PI / 4 + gapHalf, a1 = Math.PI / 4 - gapHalf + Math.PI * 2;
  const p = (ang) => [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  const [sx, sy] = p(a0), [ex, ey] = p(a1);
  const ax = (d) => (cx + d * C).toFixed(2), ay = (d) => (cy + d * C).toFixed(2);
  const body = `
    <path d="M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}" fill="none" stroke="${BLUE}" stroke-width="${sw}" stroke-linecap="round"/>
    <line x1="${ax(slashIn)}" y1="${ay(slashIn)}" x2="${ax(slashOut)}" y2="${ay(slashOut)}" stroke="${BLUE}" stroke-width="${sw}" stroke-linecap="round"/>
    <circle cx="${ax(dotTL)}" cy="${ay(dotTL)}" r="${dotTLr}" fill="${BLUE}"/>
    <circle cx="${ax(dotBR)}" cy="${ay(dotBR)}" r="${dotBRr}" fill="${BLUE}"/>`;
  const min = Math.min(cx + dotTL * C - dotTLr, cx - r - sw / 2);
  const max = Math.max(cx + dotBR * C + dotBRr, cx + slashOut * C + sw, cx + r + sw / 2);
  return { body, min, max, size: max - min };
}

function markSvg(canvas, contentSize, bg) {
  const mc = markContent();
  const s = contentSize / mc.size;
  const off = (canvas - contentSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  ${bg ? `<rect width="${canvas}" height="${canvas}" fill="${bg}"/>` : ""}
  <g transform="translate(${(off - mc.min * s).toFixed(2)} ${(off - mc.min * s).toFixed(2)}) scale(${s.toFixed(4)})">${mc.body}</g>
</svg>`;
}

// ---------- full logo: mark + hand-built "Qiji" wordmark + slogan ----------
function fullSvg() {
  const Wd = 1390, Ht = 414;
  const mc = markContent();
  const markH = 386, s = markH / mc.size, mx = 10, my = (Ht - markH) / 2;

  // wordmark params
  const SW = 50, B = 252;
  const qcx = 591, qcy = 137, qr = 90;               // Q ring (centerline)
  const tail = (d) => [(qcx + d * C).toFixed(2), (qcy + d * C).toFixed(2)];
  const [t1x, t1y] = tail(60), [t2x, t2y] = tail(148);
  const ix = 793, jx = 888, ix2 = 983;                // stem centers (Q i j i)
  const stemTop = 117, dotY = 46, dotR = 29;
  const hookR = 56;

  const word = `
    <circle cx="${qcx}" cy="${qcy}" r="${qr}" fill="none" stroke="${BLUE}" stroke-width="${SW}"/>
    <line x1="${t1x}" y1="${t1y}" x2="${t2x}" y2="${t2y}" stroke="${BLUE}" stroke-width="${SW}" stroke-linecap="round"/>
    <line x1="${ix}" y1="${stemTop}" x2="${ix}" y2="${B - SW / 2}" stroke="${BLUE}" stroke-width="${SW}" stroke-linecap="round"/>
    <circle cx="${ix}" cy="${dotY}" r="${dotR}" fill="${BLUE}"/>
    <path d="M ${jx} ${stemTop} L ${jx} ${B} A ${hookR} ${hookR} 0 0 1 ${jx - hookR} ${B + hookR}" fill="none" stroke="${BLUE}" stroke-width="${SW}" stroke-linecap="round"/>
    <circle cx="${jx}" cy="${dotY}" r="${dotR}" fill="${BLUE}"/>
    <line x1="${ix2}" y1="${stemTop}" x2="${ix2}" y2="${B - SW / 2}" stroke="${BLUE}" stroke-width="${SW}" stroke-linecap="round"/>
    <circle cx="${ix2}" cy="${dotY}" r="${dotR}" fill="${BLUE}"/>`;

  const slogan = `<text x="476" y="400" font-family="Microsoft YaHei" font-size="58" letter-spacing="10" fill="${BLUE}">万物皆为灵感  创作无限可能</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${Ht}" viewBox="0 0 ${Wd} ${Ht}">
  <g transform="translate(${(mx - mc.min * s).toFixed(2)} ${(my - mc.min * s).toFixed(2)}) scale(${s.toFixed(4)})">${mc.body}</g>
  ${word}
  ${slogan}
</svg>`;
}

async function main() {
  const jobs = [
    ["logo-mark.svg", markSvg(512, 484, null), [["logo-mark.png", 320]]],
    ["icon-1024.svg", markSvg(1024, 664, "#ffffff"), [["icon-1024.png", 1024]]],
    ["mark-small.svg", markSvg(512, 484, null), [["mark-small.png", 118]]],
    ["logo-full.svg", fullSvg(), [["logo-full.png", 1390], ["biglogo.png", 500]]],
  ];
  for (const [svgName, svg, outs] of jobs) {
    fs.writeFileSync(path.join(OUT, svgName), svg);
    for (const [png, w] of outs) {
      let img = sharp(Buffer.from(svg), { density: 300 });
      if (w) img = img.resize({ width: w });
      const info = await img.png().toFile(path.join(OUT, png));
      console.log(png, info.width + "x" + info.height);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
