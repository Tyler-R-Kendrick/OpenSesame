/**
 * Public material for a browser-managed certificate profile (UI-BROWSER).
 *
 * The certificate a browser presents is installed outside this app. What the
 * app can honestly do is hold its *public* half for the session: read a PEM
 * a person hands it, refuse anything with a private key in it, compute the
 * leaf thumbprint an operator binds to, and give the same public bytes back
 * as a download. Nothing here is persisted — a PEM is not a setting
 * (`transport-settings.ts` refuses one) — and nothing here installs, attaches
 * or presents anything.
 */

export const PUBLIC_PEM_MAX_BYTES = 65_536;

const CERT_BLOCK =
  /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g;
const KEY_BLOCK = /-----BEGIN [A-Z ]*(PRIVATE KEY|PRIVATE|SECRET)/i;

export type BrowserCertificateMaterial = {
  /** SHA-256 of the leaf's DER, lowercase hex — the `leaf_thumbprint_sha256` selector. */
  thumbprint: string;
  /** How many CERTIFICATE blocks the PEM carried (leaf first). */
  chainLength: number;
  /** The public PEM, exactly the certificate blocks and nothing else. */
  pem: string;
  importedAt: string;
};

export type PublicPemRefusal =
  | "too_large"
  | "private_material"
  | "no_certificate"
  | "malformed";

export class PublicPemError extends Error {
  constructor(readonly reason: PublicPemRefusal) {
    super(reason);
    this.name = "PublicPemError";
  }
}

function derOf(base64: string): Uint8Array {
  const raw = atob(base64.replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Read a public certificate PEM. Private material anywhere in the text
 * refuses the whole import — a person pasting a combined file must not have
 * its key silently kept in memory beside the cert they meant to share.
 */
export async function importPublicCertificatePem(
  text: string,
  now: () => number = Date.now,
): Promise<BrowserCertificateMaterial> {
  if (text.length > PUBLIC_PEM_MAX_BYTES) throw new PublicPemError("too_large");
  if (KEY_BLOCK.test(text)) throw new PublicPemError("private_material");
  const blocks = Array.from(text.matchAll(CERT_BLOCK), (m) => m[1] ?? "");
  if (blocks.length === 0) throw new PublicPemError("no_certificate");
  let leaf: Uint8Array;
  try {
    leaf = derOf(blocks[0] ?? "");
  } catch {
    throw new PublicPemError("malformed");
  }
  // A DER certificate is a SEQUENCE; anything else is not one.
  if (leaf.length < 4 || leaf[0] !== 0x30)
    throw new PublicPemError("malformed");
  const digest = await crypto.subtle.digest("SHA-256", leaf);
  const pem = blocks
    .map((body) => {
      const flat = body.replace(/\s+/g, "");
      const lines = flat.match(/.{1,64}/g) ?? [];
      return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
    })
    .join("");
  return {
    thumbprint: hex(digest),
    chainLength: blocks.length,
    pem,
    importedAt: new Date(now()).toISOString(),
  };
}

let held: BrowserCertificateMaterial | null = null;
const listeners = new Set<() => void>();

/** The public material this tab holds, or null. In memory only. */
export function heldBrowserCertificate(): BrowserCertificateMaterial | null {
  return held;
}

export function holdBrowserCertificate(
  material: BrowserCertificateMaterial | null,
): void {
  held = material;
  for (const listener of listeners) listener();
}

export function subscribeBrowserCertificate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A download of the public PEM and nothing else. */
export function exportPublicCertificatePem(
  material: BrowserCertificateMaterial,
): { filename: string; blob: Blob } {
  return {
    filename: `browser-certificate-${material.thumbprint.slice(0, 12)}.pem`,
    blob: new Blob([material.pem], { type: "application/x-pem-file" }),
  };
}
