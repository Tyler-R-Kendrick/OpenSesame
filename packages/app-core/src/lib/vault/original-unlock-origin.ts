/** A retained browser directory identity, not an authentication or lock proof. */
import { host } from "../../host.js";
export function captureOriginalUnlockOrigin(original: () => void) {
  original();
  const installed = host();
  const provider = installed.originFiles;
  let owned:
    | Readonly<{
        root: FileSystemDirectoryHandle;
        file: FileSystemDirectoryHandle["getFileHandle"];
        same: FileSystemDirectoryHandle["isSameEntry"];
      }>
    | undefined;
  const check = () => {
    original();
    if (
      host() !== installed ||
      installed.originFiles !== provider ||
      (owned &&
        (owned.root.getFileHandle !== owned.file ||
          owned.root.isSameEntry !== owned.same))
    )
      throw new Error("Original unlock directory changed.");
  };
  return Object.freeze({
    check,
    root: () => {
      check();
      return owned?.root;
    },
    revalidate: async () => {
      check();
      if (provider === undefined) return;
      // Opening starts only in this awaited call, after transport validation.
      if (!owned) {
        const root = await provider.call(installed);
        check();
        owned = Object.freeze({
          root,
          file: root.getFileHandle,
          same: root.isSameEntry,
        });
      }
      check();
      if (!owned) throw new Error("Original unlock directory is unavailable.");
      const current = await provider.call(installed);
      check();
      const same = await owned.same.call(owned.root, current);
      check();
      if (!same) throw new Error("Original unlock directory changed.");
    },
  });
}
