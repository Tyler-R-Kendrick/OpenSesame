/** Captured origin receiver/method identity DATA only; no caller callback or key is retained. */
function changed(): never {
  throw new Error("Original origin file receiver methods changed.");
}
export function captureOriginalOriginDirectoryData(
  root: FileSystemDirectoryHandle,
) {
  const get = root.getFileHandle;
  const same = root.isSameEntry;
  const remove = root.removeEntry;
  const check = () => {
    if (
      root.getFileHandle !== get ||
      root.isSameEntry !== same ||
      root.removeEntry !== remove
    )
      changed();
  };
  return Object.freeze({ receiver: root, get, same, remove, check });
}
export function captureOriginalOriginFileData(handle: FileSystemFileHandle) {
  const get = handle.getFile;
  const create = handle.createWritable;
  const same = handle.isSameEntry;
  const check = () => {
    if (
      handle.getFile !== get ||
      handle.createWritable !== create ||
      handle.isSameEntry !== same
    )
      changed();
  };
  return Object.freeze({ receiver: handle, get, create, same, check });
}
export function captureOriginalOriginStreamData(
  stream: FileSystemWritableFileStream,
) {
  const write = stream.write;
  const close = stream.close;
  const abort = stream.abort;
  const check = () => {
    if (
      stream.write !== write ||
      stream.close !== close ||
      stream.abort !== abort
    )
      changed();
  };
  return Object.freeze({ receiver: stream, write, close, abort, check });
}
export type OriginalOriginDirectoryData = ReturnType<
  typeof captureOriginalOriginDirectoryData
>;
export type OriginalOriginFileData = ReturnType<
  typeof captureOriginalOriginFileData
>;
export type OriginalOriginStreamData = ReturnType<
  typeof captureOriginalOriginStreamData
>;
