/**
 * SHA-256 over a byte string, synchronous and dependency-free so the parser
 * entry stays usable without `node:crypto` or an async WebCrypto call. The
 * corpus pins its output against digests computed elsewhere.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function pad(input: Uint8Array): DataView {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(input);
  data[input.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(
    paddedLength - 8,
    Math.floor(bitLength / 0x1_0000_0000),
    false,
  );
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  return view;
}

function schedule(view: DataView, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
  for (let i = 16; i < 64; i += 1) {
    const w15 = w[i - 15] as number;
    const w2 = w[i - 2] as number;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
  }
}

/** One compression round over a scheduled block; `v` is the working state a..h. */
function compress(h: Uint32Array, w: Uint32Array, v: Uint32Array): void {
  v.set(h);
  for (let i = 0; i < 64; i += 1) {
    const [a, b, c, d, e, f, g, hh] = v as unknown as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    v[7] = g;
    v[6] = f;
    v[5] = e;
    v[4] = (d + t1) >>> 0;
    v[3] = c;
    v[2] = b;
    v[1] = a;
    v[0] = (t1 + t2) >>> 0;
  }
  for (let i = 0; i < 8; i += 1)
    h[i] = ((h[i] as number) + (v[i] as number)) >>> 0;
}

export function sha256Hex(input: Uint8Array): string {
  const view = pad(input);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const v = new Uint32Array(8);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    schedule(view, offset, w);
    compress(h, w, v);
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
