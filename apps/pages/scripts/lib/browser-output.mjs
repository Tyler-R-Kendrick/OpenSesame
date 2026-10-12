/**
 * The browsers' own output, kept apart from the walk's. A content process
 * that crashes says why only on its browser's stderr, which Playwright prints
 * under `DEBUG=pw:browser` among the walk's own lines. Those lines go to
 * `file` instead, opened on the first one and written as they come, so a run
 * that exits on a failure keeps every line; the walk's own output stays on
 * the terminal.
 */

import fs from "node:fs";

const BROWSER_LINE = " pw:browser ";

/** Divert Playwright's `pw:browser` lines from `stream` to `file`. */
export function keepBrowserOutput(file, stream = process.stderr) {
  let fd;
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (!String(chunk).includes(BROWSER_LINE))
      return write(chunk, encoding, callback);
    fd ??= fs.openSync(file, "w");
    fs.writeSync(fd, chunk);
    // write(chunk, callback) and write(chunk, encoding, callback) both answer.
    [encoding, callback].find((arg) => arg instanceof Function)?.();
    return true;
  };
}
