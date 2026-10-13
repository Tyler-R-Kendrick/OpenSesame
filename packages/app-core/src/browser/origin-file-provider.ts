/** A stable original native provider for one unchanged StorageManager method. */
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
export function createBrowserOriginFileProvider() {
  let manager: StorageManager | undefined;
  let method: StorageManager["getDirectory"] | undefined;
  let provider: (() => Promise<FileSystemDirectoryHandle>) | undefined;
  return () => {
    const current = globalThis.navigator?.storage;
    const get = current?.getDirectory;
    if (!current || !get) return undefined;
    if (current !== manager || get !== method) {
      manager = current;
      method = get;
      const fixed: typeof get = bindOriginal(get, current);
      provider = () => {
        if (
          globalThis.navigator?.storage !== current ||
          current.getDirectory !== get
        )
          throw new Error("Original browser storage provider changed.");
        return fixed();
      };
    }
    return provider;
  };
}
