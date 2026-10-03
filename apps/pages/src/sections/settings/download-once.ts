/**
 * Hand the person a file the page will not keep a copy of. The object URL
 * outlives the click: some engines cancel the download if it is revoked in the
 * same task, and this file may be the only copy of a generated key.
 */
export function downloadOnce(filename: string, body: string): void {
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
