/**
 * Hand the person a file through the File System Access picker where the
 * browser has one, else a Blob URL download. Injectable so a test can catch
 * the bytes instead of the browser.
 */

import { saveTextFile as saveThroughPicker } from "../../lib/file-system.js";

export const downloadSeams = {
  save(fileName: string, text: string, type = "application/yaml"): void {
    void saveThroughPicker(fileName, text, type).catch(() => undefined);
  },
};

export function saveTextFile(fileName: string, text: string): void {
  downloadSeams.save(fileName, text);
}
