import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * The checked-in PWA raster icons, generated from the same geometry as
 * `public/icon.svg`. Keeping the generator here makes an icon change a small
 * diff instead of a binary-only edit.
 */
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return new Uint8Array([...length, ...body, ...crc]);
}

function png(size) {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / 64;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const u = x / scale;
      const v = y / scale;
      let color = [0x14, 0x14, 0x14, 0xff];
      if (u >= 14 && u < 39.41 && v >= 14 && v < 50)
        color = [0xfa, 0xfa, 0xfa, 0xff];
      else if (u >= 45.13 && u < 50 && v >= 14 && v < 50)
        color = [0x8f, 0x8f, 0x8f, 0xff];
      pixels.set(color, at);
    }
  }
  const scanlines = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    scanlines[y * (size * 4 + 1)] = 0;
    scanlines.set(
      pixels.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1,
    );
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Uint8Array([
    ...signature,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", deflateSync(scanlines)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

for (const size of [192, 512])
  await writeFile(join(root, "public", `icon-${size}.png`), png(size));
