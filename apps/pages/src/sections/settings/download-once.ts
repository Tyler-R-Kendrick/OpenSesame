/**
 * Hand the person a file the page will not keep a copy of, without opening a
 * save picker. The object URL outlives the click because some engines cancel
 * a download if it is revoked in the same task, and this file may be the
 * only copy of a generated key.
 */

import { type SaveOutcome, downloadBlob } from "../../lib/file-system.js";

export async function downloadOnce(
  filename: string,
  body: string,
): Promise<SaveOutcome> {
  downloadBlob(new Blob([body], { type: "text/plain" }), filename);
  return "downloaded";
}
