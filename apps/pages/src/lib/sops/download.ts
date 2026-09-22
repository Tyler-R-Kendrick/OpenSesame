/**
 * Portable encrypted output (B12, PERSIST-01, SB-075): an ordinary Blob
 * download that works in Firefox and WebKit with no File System Access
 * API, no native handler, and no platform filesystem privilege.
 *
 * The object URL is revoked on the next frame, and every URL this module
 * hands out is revoked again on `releaseDownloads()` so a lock cannot
 * leave a live handle to plaintext or ciphertext behind.
 */

const live = new Set<string>();

export type DownloadKind = "encrypted" | "plaintext";

/**
 * Offer `text` as a file. `kind` is explicit at every call site so a
 * plaintext download can never be reached by mistake: normal save and
 * export pass "encrypted", and only a separately confirmed human action
 * passes "plaintext".
 */
export function downloadText(
  fileName: string,
  text: string,
  kind: DownloadKind,
): void {
  const type = kind === "encrypted" ? "application/octet-stream" : "text/plain";
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  live.add(url);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
  // Revoking synchronously can cancel the download in some engines.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    live.delete(url);
  }, 0);
}

/** Revoke every object URL this module still holds (lock, close, logout). */
export function releaseDownloads(): void {
  for (const url of live) URL.revokeObjectURL(url);
  live.clear();
}

/** The file name for an encrypted copy of `source`, never overwriting it. */
export function encryptedName(source: string, format: "yaml" | "json"): string {
  const base =
    source.replace(/\.(ya?ml|json)$/iu, "").replace(/\.sops$/iu, "") ||
    "document";
  return `${base}.sops.${format === "json" ? "json" : "yaml"}`;
}
