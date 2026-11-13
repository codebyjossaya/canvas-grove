// Renders the Canvas Grove mark (same geometry as .grove-mark in app/globals.css) to PNG icons.
//   node extension/tools/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "icons");
mkdirSync(out, { recursive: true });

const ACCENT = [0x4b, 0x4f, 0xd6];
// [x, y, size, radius, white-alpha] in the mark's native 20x20 space.
const SQUARES = [[4, 4, 6, 2, 1], [10, 4, 6, 2, 0.7], [4, 10, 6, 2, 0.7], [10, 10, 6, 2, 0.4]];

function inRounded(u, v, x, y, w, h, r) {
  if (u < x || u > x + w || v < y || v > y + h) return false;
  const cx = u < x + r ? x + r : u > x + w - r ? x + w - r : u;
  const cy = v < y + r ? y + r : v > y + h - r ? y + h - r : v;
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function render(size) {
  const SS = 8, rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let inside = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = ((px + (sx + 0.5) / SS) / size) * 20, v = ((py + (sy + 0.5) / SS) / size) * 20;
      if (!inRounded(u, v, 0, 0, 20, 20, 6)) continue;
      let cr = ACCENT[0], cg = ACCENT[1], cb = ACCENT[2];
      for (const [x, y, s, rad, a] of SQUARES) if (inRounded(u, v, x, y, s, s, rad)) { cr = cr * (1 - a) + 255 * a; cg = cg * (1 - a) + 255 * a; cb = cb * (1 - a) + 255 * a; }
      inside++; r += cr; g += cg; b += cb;
    }
    const i = (py * size + px) * 4;
    if (inside) { rgba[i] = Math.round(r / inside); rgba[i + 1] = Math.round(g / inside); rgba[i + 2] = Math.round(b / inside); rgba[i + 3] = Math.round((inside / (SS * SS)) * 255); }
  }
  return rgba;
}

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const check = Buffer.alloc(4); check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
}
function png(size) {
  const raw = render(size), rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { rows[y * (size * 4 + 1)] = 0; raw.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
for (const size of [16, 32, 48, 128]) { writeFileSync(join(out, `${size}.png`), png(size)); console.log("wrote", `${size}.png`); }
