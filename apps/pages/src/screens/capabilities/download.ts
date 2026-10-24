/**
 * Hand the person a file through the File System Access picker where the
 * browser has one, else a Blob URL download. Injectable so a test can catch
 * the bytes instead of the browser.
 */

import {
  type SaveOutcome,
  saveTextFile as saveThroughPicker,
} from "../../lib/file-system.js";

type DownloadSeams = {
  save(
    fileName: string,
    text: string,
    type?: string,
  ): Promise<SaveOutcome> | undefined;
};

export const downloadSeams: DownloadSeams = {
  save(fileName, text, type = "application/yaml") {
    return saveThroughPicker(fileName, text, type);
  },
};

export async function saveTextFile(
  fileName: string,
  text: string,
): Promise<SaveOutcome> {
  return (await downloadSeams.save(fileName, text)) ?? "downloaded";
}
