#!/usr/bin/env node
/**
 * Writes public/icon.svg from lock-v5 static mark geometry (drawIconMark in
 * CipherWordmark/particles.ts): ink block + teal slit, unit = height / 17.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outSvg = join(root, "public", "icon.svg");

const VIEW = 64;
const PAD = 14;
const MARK_H = 36;
const u = MARK_H / 17;
const INK_W = 12 * u;
const SLIT_X = PAD + 14.7 * u;
const SLIT_W = 2.3 * u;
const ACCENT = "#2fb3a3";
const INK = "#fafafa";
const BG = "#141414";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="OpenSesame">
  <rect width="${VIEW}" height="${VIEW}" rx="14" fill="${BG}"/>
  <rect x="${PAD}" y="${PAD}" width="${INK_W.toFixed(2)}" height="${MARK_H}" fill="${INK}"/>
  <rect x="${SLIT_X.toFixed(2)}" y="${PAD}" width="${SLIT_W.toFixed(2)}" height="${MARK_H}" fill="${ACCENT}"/>
</svg>
`;

writeFileSync(outSvg, svg, "utf8");
console.log(`wrote ${outSvg}`);
