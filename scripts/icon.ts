// Draws FreePoster's icon (a white play mark on a blue rounded square) as PNG and ICO, without image tools.
import { crc32, deflateSync } from "node:zlib";

/** RGBA pixels of the icon at the given size, anti-aliased by 4×4 supersampling. */
function draw(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  const radius = 0.22; // corner radius, as a fraction of the size
  // play triangle, in unit coordinates
  const [ax, ay, bx, by, cx, cy] = [0.38, 0.28, 0.38, 0.72, 0.74, 0.5];
  const side = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0, white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
          const dx = Math.max(radius - u, u - (1 - radius), 0), dy = Math.max(radius - v, v - (1 - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
          cover++;
          const s1 = side(u, v, ax, ay, bx, by), s2 = side(u, v, bx, by, cx, cy), s3 = side(u, v, cx, cy, ax, ay);
          if ((s1 <= 0 && s2 <= 0 && s3 <= 0) || (s1 >= 0 && s2 >= 0 && s3 >= 0)) white++;
        }
      }
      const t = (x + y) / (2 * size); // diagonal gradient
      const blue = [0x4a + (0x1a - 0x4a) * t, 0x86 + (0x4c - 0x86) * t, 0xff + (0xdb - 0xff) * t];
      const w = cover ? white / cover : 0;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(blue[c] + (255 - blue[c]) * w);
      px[i + 3] = Math.round((cover / (ss * ss)) * 255);
    }
  }
  return px;
}

function png(size: number): Buffer {
  const rgba = draw(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A Windows .ico holding PNG images at the usual sizes. */
function ico(): Buffer {
  const images = [256, 48, 32, 16].map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = header[e + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

export const iconPng = () => png(256);
export const iconIco = ico;
