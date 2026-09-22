/**
 * Hand the person a file. A Blob URL, a click, a revoke — no service, no
 * request. Injectable so a test can catch the bytes instead of the browser.
 */

export const downloadSeams = {
  save(fileName: string, text: string, type = "application/yaml"): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};

export function saveTextFile(fileName: string, text: string): void {
  downloadSeams.save(fileName, text);
}
