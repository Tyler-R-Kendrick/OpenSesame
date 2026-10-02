/**
 * Peer receipt signing/verification (PEER-B). Receipts acknowledge a peer
 * envelope; a receipt counts only with a valid paired-key signature.
 */

export type PeerReceipt = Readonly<{
  schemaVersion: 1;
  requestNonce: string;
  recipientDeviceBinding: string;
  status: "accepted" | "rejected";
  at: string;
  signatureB64: string;
}>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function receiptSigningInput(
  receipt: Omit<PeerReceipt, "signatureB64">,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: receipt.schemaVersion,
      requestNonce: receipt.requestNonce,
      recipientDeviceBinding: receipt.recipientDeviceBinding,
      status: receipt.status,
      at: receipt.at,
    }),
  );
}

export async function signPeerReceipt(
  receipt: Omit<PeerReceipt, "signatureB64" | "schemaVersion">,
  privateKey: CryptoKey,
): Promise<PeerReceipt> {
  const full = { schemaVersion: 1 as const, ...receipt };
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      receiptSigningInput(full),
    ),
  );
  return { ...full, signatureB64: b64(sig) };
}

export async function verifyPeerReceipt(
  receipt: PeerReceipt,
  publicKey: CryptoKey,
): Promise<boolean> {
  if (receipt.schemaVersion !== 1) return false;
  if (receipt.status !== "accepted" && receipt.status !== "rejected") {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromB64(receipt.signatureB64),
      receiptSigningInput(receipt),
    );
  } catch {
    return false;
  }
}
