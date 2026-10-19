/** Captured origin receiver/method identity DATA only; no caller callback or key is retained. */
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
function changed(): never {
  throw new Error("Original origin file receiver methods changed.");
}
export function captureOriginalOriginDirectoryData(
  root: FileSystemDirectoryHandle,
) {
  const get = root.getFileHandle;
  const fixedGet: typeof get = bindOriginal(get, root);
  const same = root.isSameEntry;
  const fixedSame: typeof same = bindOriginal(same, root);
  const remove = root.removeEntry;
  const fixedRemove: typeof remove = bindOriginal(remove, root);
  const check = () => {
    if (
      root.getFileHandle !== get ||
      root.isSameEntry !== same ||
      root.removeEntry !== remove
    )
      changed();
  };
  return Object.freeze({
    receiver: root,
    get: fixedGet,
    same: fixedSame,
    remove: fixedRemove,
    check,
  });
}
export function captureOriginalOriginFileData(handle: FileSystemFileHandle) {
  const get = handle.getFile;
  const fixedGet: typeof get = bindOriginal(get, handle);
  const create = handle.createWritable;
  const fixedCreate: typeof create = bindOriginal(create, handle);
  const same = handle.isSameEntry;
  const fixedSame: typeof same = bindOriginal(same, handle);
  const check = () => {
    if (
      handle.getFile !== get ||
      handle.createWritable !== create ||
      handle.isSameEntry !== same
    )
      changed();
  };
  return Object.freeze({
    receiver: handle,
    get: fixedGet,
    create: fixedCreate,
    same: fixedSame,
    check,
  });
}
/** Own the actual abort before any later writable method delivery can refuse. */
export function captureOriginalOriginStreamAbortData(
  stream: FileSystemWritableFileStream,
) {
  const abort = stream.abort;
  const fixedAbort: typeof abort = bindOriginal(abort, stream);
  const check = () => {
    if (stream.abort !== abort) changed();
  };
  return Object.freeze({ receiver: stream, abort: fixedAbort, check });
}
export function captureOriginalOriginStreamData(
  stream: FileSystemWritableFileStream,
  retainedAbort = captureOriginalOriginStreamAbortData(stream),
) {
  if (retainedAbort.receiver !== stream) changed();
  const write = stream.write;
  const fixedWrite: typeof write = bindOriginal(write, stream);
  const close = stream.close;
  const fixedClose: typeof close = bindOriginal(close, stream);
  const check = () => {
    if (stream.write !== write || stream.close !== close) changed();
    retainedAbort.check();
  };
  return Object.freeze({
    receiver: stream,
    write: fixedWrite,
    close: fixedClose,
    abort: retainedAbort.abort,
    check,
  });
}
export type OriginalOriginDirectoryData = ReturnType<
  typeof captureOriginalOriginDirectoryData
>;
export type OriginalOriginFileData = ReturnType<
  typeof captureOriginalOriginFileData
>;
export type OriginalOriginStreamAbortData = ReturnType<
  typeof captureOriginalOriginStreamAbortData
>;
export type OriginalOriginStreamData = ReturnType<
  typeof captureOriginalOriginStreamData
>;

/** Captured enumeration receiver DATA; write-only captures need no iterator. */
export function captureOriginalOriginDirectoryNamesData(
  root: FileSystemDirectoryHandle,
) {
  const keys = root.keys;
  const fixedKeys: typeof keys = bindOriginal(keys, root);
  const check = () => {
    if (root.keys !== keys) changed();
  };
  return Object.freeze({ keys: fixedKeys, check });
}
