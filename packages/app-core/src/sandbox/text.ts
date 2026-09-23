/**
 * UTF-8 and base64 for an isolate that has neither (ADR 0133 §6): the
 * `TextEncoder`, `TextDecoder`, `atob` and `btoa` of the runtime contract,
 * written to the WHATWG Encoding and HTML specs' observable behaviour —
 * lone surrogates encode as U+FFFD, malformed input decodes to U+FFFD, and
 * `atob` rejects anything that is not forgiving-base64.
 */

const REPLACEMENT = 0xfffd;

function pushCodePoint(out: number[], point: number): void {
  if (point < 0x80) out.push(point);
  else if (point < 0x800) out.push(0xc0 | (point >> 6), 0x80 | (point & 63));
  else if (point < 0x10000)
    out.push(
      0xe0 | (point >> 12),
      0x80 | ((point >> 6) & 63),
      0x80 | (point & 63),
    );
  else
    out.push(
      0xf0 | (point >> 18),
      0x80 | ((point >> 12) & 63),
      0x80 | ((point >> 6) & 63),
      0x80 | (point & 63),
    );
}

export class SandboxTextEncoder {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    const out: number[] = [];
    for (const char of String(input)) {
      const point = char.codePointAt(0) ?? REPLACEMENT;
      const lone = point >= 0xd800 && point <= 0xdfff;
      pushCodePoint(out, lone ? REPLACEMENT : point);
    }
    return Uint8Array.from(out);
  }
}

/** Length and lead-byte payload of a UTF-8 sequence; null for an invalid lead. */
function sequence(lead: number): { length: number; bits: number } | null {
  if (lead < 0x80) return { length: 1, bits: lead };
  if (lead >= 0xc2 && lead <= 0xdf) return { length: 2, bits: lead & 31 };
  if (lead >= 0xe0 && lead <= 0xef) return { length: 3, bits: lead & 15 };
  if (lead >= 0xf0 && lead <= 0xf4) return { length: 4, bits: lead & 7 };
  return null;
}

/**
 * The range the second byte must fall in (WHATWG Encoding, UTF-8 decoder):
 * narrower after E0, ED, F0 and F4, which is what rules out overlong forms,
 * surrogates and code points past U+10FFFF.
 */
function secondByteRange(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf];
  if (lead === 0xed) return [0x80, 0x9f];
  if (lead === 0xf0) return [0x90, 0xbf];
  if (lead === 0xf4) return [0x80, 0x8f];
  return [0x80, 0xbf];
}

/** A decoded code point, the bytes it used, and whether they were well formed. */
type Decoded = [point: number, used: number, valid: boolean];

/**
 * Decode one code point at `index`. A malformed sequence yields one U+FFFD
 * for its maximal valid prefix; the offending byte is decoded afresh.
 */
function decodeAt(bytes: Uint8Array, index: number): Decoded {
  const lead = bytes[index] ?? 0;
  const head = sequence(lead);
  if (!head) return [REPLACEMENT, 1, false];
  let point = head.bits;
  for (let offset = 1; offset < head.length; offset += 1) {
    const next = bytes[index + offset];
    const [lower, upper] = offset === 1 ? secondByteRange(lead) : [0x80, 0xbf];
    if (next === undefined || next < lower || next > upper)
      return [REPLACEMENT, offset, false];
    point = (point << 6) | (next & 63);
  }
  return [point, head.length, true];
}

function toBytes(input: ArrayBuffer | ArrayBufferView | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

export class SandboxTextDecoder {
  readonly encoding = "utf-8";
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = "utf-8", options: TextDecoderOptions = {}) {
    if (!/^\s*(utf-?8|unicode-1-1-utf-8)\s*$/i.test(label))
      throw new RangeError(`The encoding label "${label}" is not supported`);
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    const bytes = toBytes(input);
    let text = "";
    let index =
      !this.ignoreBOM &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
        ? 3
        : 0;
    while (index < bytes.length) {
      const [point, used, valid] = decodeAt(bytes, index);
      if (!valid && this.fatal)
        throw new TypeError("The encoded data was not valid utf-8");
      text += String.fromCodePoint(point);
      index += used;
    }
    return text;
  }
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function invalidCharacter(message: string): Error {
  const error = new Error(message);
  error.name = "InvalidCharacterError";
  return error;
}

export function sandboxBtoa(data: string): string {
  const text = String(data);
  let out = "";
  for (let index = 0; index < text.length; index += 3) {
    const codes = [0, 1, 2].map((at) => text.charCodeAt(index + at));
    if (codes.some((code) => code > 0xff))
      throw invalidCharacter("btoa: character outside of Latin1 range");
    const [a = 0, b = 0, c = 0] = codes.map((code) =>
      Number.isNaN(code) ? 0 : code,
    );
    const triple = (a << 16) | (b << 8) | c;
    const left = text.length - index;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += left > 1 ? ALPHABET[(triple >> 6) & 63] : "=";
    out += left > 2 ? ALPHABET[triple & 63] : "=";
  }
  return out;
}

export function sandboxAtob(data: string): string {
  let text = String(data).replace(/[\t\n\f\r ]/g, "");
  if (text.length % 4 === 0) text = text.replace(/==?$/, "");
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text))
    throw invalidCharacter("atob: the string is not correctly encoded");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}
