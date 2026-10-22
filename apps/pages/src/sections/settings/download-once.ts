/**
 * Hand the person a file the page will not keep a copy of. The File System
 * Access save picker is used where it exists; otherwise the object URL
 * outlives the click because some engines cancel a download if it is revoked
 * in the same task, and this file may be the only copy of a generated key.
 */

import { saveTextFile } from "../../lib/file-system.js";

export function downloadOnce(filename: string, body: string): void {
  void saveTextFile(filename, body, "text/plain", "OpenSesame file").catch(
    () => undefined,
  );
}
