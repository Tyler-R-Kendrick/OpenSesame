import {
  encode,
  renderSVG,
  renderUnicodeCompact,
  type QrCodeGenerateSvgOptions,
} from "uqr";

export class QrEncodeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "QrEncodeError";
  }
}

export type QrSvgOptions = {
  /** Module pixel size in the SVG. Default 4. */
  pixelSize?: number;
  /** Quiet zone modules. Default 2. */
  border?: number;
  dark?: string;
  light?: string;
};

export type QrTerminalOptions = {
  border?: number;
};

function assertPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new QrEncodeError("QR payload must not be empty");
  }
  return trimmed;
}

/** Encode a string as an SVG QR (error correction M). */
export function encodeQrSvg(
  value: string,
  options: QrSvgOptions = {},
): string {
  const payload = assertPayload(value);
  const svgOpts: QrCodeGenerateSvgOptions = {
    ecc: "M",
    border: options.border ?? 2,
    pixelSize: options.pixelSize ?? 4,
    blackColor: options.dark ?? "#000000",
    whiteColor: options.light ?? "#ffffff",
  };
  return renderSVG(payload, svgOpts);
}

/**
 * Compact Unicode QR for terminals (two modules per character row).
 * Suitable for TTY device-login handoff.
 */
export function encodeQrTerminal(
  value: string,
  options: QrTerminalOptions = {},
): string {
  const payload = assertPayload(value);
  return renderUnicodeCompact(payload, {
    ecc: "M",
    border: options.border ?? 1,
  });
}

/** Matrix size for tests / diagnostics. */
export function encodeQrSize(value: string): number {
  const payload = assertPayload(value);
  return encode(payload, { ecc: "M", border: 2 }).size;
}
