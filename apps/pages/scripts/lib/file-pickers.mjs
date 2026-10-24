// The browser's file pickers, as a person drives them, in a headless context.
//
// Where the File System Access API exists the app saves through
// `showSaveFilePicker` and opens through `showOpenFilePicker`
// (`src/lib/file-system.ts`). Headless Chromium has no dialog to show: its
// pickers reject as if the person had cancelled, so a save writes nothing and
// a walk waiting for the file waits forever. Playwright cannot drive these
// dialogs, so a context stands one in for each, at the same seam the browser
// does:
//
// - the save picker hands back a handle whose writable collects what the app
//   writes, and on close() delivers exactly those bytes, under the suggested
//   name, as a download the walk receives;
// - the open picker asks through an `<input type="file">`, so the walk answers
//   it with the file chooser it already uses, and a dismissed chooser is a
//   cancellation (`AbortError`), as it is in the browser.
//
// The app still runs its own picker path (the "saved" outcome, its write and
// close, its cancel handling). A browser without the API (Firefox, WebKit) is
// left alone and takes the app's anchor download.

function standInPickers() {
  if ("showSaveFilePicker" in window) {
    window.showSaveFilePicker = async (options = {}) => {
      const name = options.suggestedName || "download";
      return {
        kind: "file",
        name,
        async createWritable() {
          const parts = [];
          return {
            async write(data) {
              // A write may be the bytes, or `{ type: "write", data }`.
              const value = data?.type === "write" ? data.data : data;
              parts.push(value instanceof Blob ? value : new Blob([value]));
            },
            async close() {
              const url = URL.createObjectURL(new Blob(parts));
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = name;
              document.body.append(anchor);
              anchor.click();
              anchor.remove();
              setTimeout(() => URL.revokeObjectURL(url), 60_000);
            },
            async abort() {
              parts.length = 0;
            },
          };
        },
      };
    };
  }
  if ("showOpenFilePicker" in window) {
    window.showOpenFilePicker = (options = {}) =>
      new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = options.multiple === true;
        input.hidden = true;
        const done = () => input.remove();
        input.addEventListener("change", () => {
          const files = [...(input.files ?? [])];
          done();
          resolve(
            files.map((file) => ({
              kind: "file",
              name: file.name,
              getFile: async () => file,
            })),
          );
        });
        input.addEventListener("cancel", () => {
          done();
          reject(new DOMException("The user aborted a request.", "AbortError"));
        });
        document.body.append(input);
        input.click();
      });
  }
}

/** Stand the save and open pickers in for every page of `context`. */
export async function emulateFilePickers(context) {
  await context.addInitScript(standInPickers);
}
