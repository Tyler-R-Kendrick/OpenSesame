import { DISPLAY_WORD } from "../CipherWordmark/cipher.js";

export const PLAIN = DISPLAY_WORD.replace(/ /g, "");
export const LETTERS = DISPLAY_WORD.split("");
export const RING_COUNT = LETTERS.length;

export const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const RING_CIPHER = "0123456789ABCDEF";

export const RING_FONT = "var(--mono)";
export const TAU = Math.PI * 2;

export const T_CLICK_MS = 780;
export const T_OPEN_MS = 920;
export const T_END_MS = 1620;

export const WEIGHTS = [
  1, 0.8, 1.12, 0.88, 1.04, 0.78, 1.16, 0.86, 1, 0.82, 1.1,
];
