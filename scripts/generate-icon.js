'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Pure-Node PNG + ICO generator for the 원탑통증재활센터 local app icon (rounded blue medical cross/calendar badge)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderIconRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const rCorner = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // Rounded square SDF
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (size / 2 - rCorner), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (size / 2 - rCorner), 0);
      const dist = Math.hypot(dx, dy) - rCorner;
      const alpha = Math.max(0, Math.min(1, 0.5 - dist));
      if (alpha <= 0) continue;

      // Gradient blue background (#1D4ED8 -> #2563EB -> #0EA5E9)
      const t = (x + y) / (2 * size);
      let r = Math.round(29 + t * (14 - 29));
      let g = Math.round(78 + t * (165 - 78));
      let b = Math.round(216 + t * (233 - 216));

      // White medical cross + subtle inner card look
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const inVert = Math.abs(nx - 0.5) <= 0.11 && ny >= 0.22 && ny <= 0.78;
      const inHoriz = Math.abs(ny - 0.5) <= 0.11 && nx >= 0.22 && nx <= 0.78;
      if (inVert || inHoriz) {
        r = 255;
        g = 255;
        b = 255;
      }

      // Small emerald dot accent at bottom-right
      const dotDist = Math.hypot(nx - 0.75, ny - 0.75);
      if (dotDist <= 0.085) {
        r = 16;
        g = 185;
        b = 129;
      }

      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngBuffersWithSize) {
  const count = pngBuffersWithSize.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, png } of pngBuffersWithSize) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffersWithSize.map((i) => i.png)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
const rendered = sizes.map((size) => ({ size, png: encodePng(size, renderIconRgba(size)) }));
const png256 = rendered.find((x) => x.size === 256).png;
const ico = encodeIco(rendered);

fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('Generated assets/icon.png and assets/icon.ico');
