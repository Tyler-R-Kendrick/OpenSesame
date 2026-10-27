/** Metadata only: every observed native operation still runs with its arguments. */
import { appendFileSync, mkdirSync } from "node:fs";

const output = new URL("../../../../artifacts/live-join/", import.meta.url);
let nextContext = 0;
function withoutRouteData(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "<unparseable-url>";
  }
}
export async function observeBlobs(context) {
  mkdirSync(output, { recursive: true });
  const contextId = ++nextContext;
  const pageIds = new WeakMap();
  const frameIds = new WeakMap();
  let nextPage = 0;
  let nextFrame = 0;
  const pageId = (page) => {
    if (!pageIds.has(page)) pageIds.set(page, ++nextPage);
    return pageIds.get(page);
  };
  const frameId = (frame) => {
    if (!frameIds.has(frame)) frameIds.set(frame, ++nextFrame);
    return frameIds.get(frame);
  };
  const record = (entry) => appendFileSync(
    new URL("blob-observation.jsonl", output),
    `${JSON.stringify({
      contextId,
      receivedAtUnixMs: Date.now(),
      receivedAtMonotonicNs: process.hrtime.bigint().toString(),
      ...entry,
    })}\n`,
  );
  await context.exposeBinding("recordBlobObservation", (source, entry) => record({
    ...entry,
    pageId: pageId(source.page),
    frameId: frameId(source.frame),
    frameUrl: withoutRouteData(source.frame.url()),
  }));
  const watch = (page) => {
    const id = pageId(page);
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      if (!location?.url?.startsWith("blob:")) return;
      record({ phase: "console-error", pageId: id, pageUrl: withoutRouteData(page.url()), location });
    });
    page.on("close", () => record({ phase: "page-close", pageId: id }));
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  context.on("close", () => record({ phase: "context-close" }));
  await context.addInitScript(() => {
    "use strict";
    const blobIds = new WeakMap();
    let nextBlob = 0;
    const blobId = (blob) => {
      if (blob === null || Object(blob) !== blob) return undefined;
      if (!blobIds.has(blob)) blobIds.set(blob, ++nextBlob);
      return blobIds.get(blob);
    };
    const withoutRouteData = (value) => {
      try {
        const url = new URL(value, location.href);
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "<unparseable-url>";
      }
    };
    const report = (entry, withStack = true) => {
      const metadata = {
        ...entry,
        browserAtUnixMs: performance.timeOrigin + performance.now(),
        documentTimeOriginMs: performance.timeOrigin,
        documentUrl: withoutRouteData(location.href),
      };
      if (withStack)
        metadata.stack = new Error().stack?.replace(/[?#][^\s)]*/g, "").slice(0, 2000) ?? "";
      void window.recordBlobObservation(metadata).catch(() => {});
    };
    const NativeBlob = window.Blob;
    window.Blob = new Proxy(NativeBlob, {
      construct(target, args, newTarget) {
        const blob = Reflect.construct(target, args, newTarget);
        report({ phase: "blob", blobId: blobId(blob), mime: blob.type, size: blob.size });
        return blob;
      },
    });
    const create = URL.createObjectURL;
    URL.createObjectURL = function (...args) {
      const url = Reflect.apply(create, this, args);
      const blob = args[0];
      report({ phase: "create", url, blobId: blobId(blob), mime: blob.type, size: blob.size });
      return url;
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (...args) {
      const result = Reflect.apply(revoke, this, args);
      report({ phase: "revoke", url: withoutRouteData(String(args[0])) });
      return result;
    };
    for (const name of ["Worker", "SharedWorker"]) {
      const NativeWorker = window[name];
      if (!NativeWorker) continue;
      window[name] = new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          report({ phase: name === "Worker" ? "worker" : "shared-worker", url: withoutRouteData(String(args[0])) });
          return Reflect.construct(target, args, newTarget);
        },
      });
    }
    // Opaque correlation stays in this document; names, data and error messages never leave it.
    const fileEntries = new WeakMap();
    const handleEntries = new WeakMap();
    const writerEntries = new WeakMap();
    const children = new Map();
    let nextEntry = 0;
    let nextOperation = 0;
    const errorNames = new Set([
      "AbortError", "NotFoundError", "InvalidStateError", "NotReadableError",
      "NoModificationAllowedError", "TypeMismatchError", "SecurityError",
      "NotAllowedError", "QuotaExceededError", "TypeError", "Error", "UnknownError",
    ]);
    const errorName = (error) => {
      try { return errorNames.has(error?.name) ? error.name : "OtherError"; }
      catch { return "OtherError"; }
    };
    const minimal = (entry) => report(entry, false);
    const entryFor = (map, object) => {
      if (object === null || Object(object) !== object) return undefined;
      if (!map.has(object)) map.set(object, `entry-${++nextEntry}`);
      return map.get(object);
    };
    const childEntry = (parent, name) => {
      if (!children.has(parent)) children.set(parent, new Map());
      const entries = children.get(parent);
      if (!entries.has(name)) entries.set(name, `entry-${++nextEntry}`);
      return entries.get(name);
    };
    const coverage = {};
    function install(prototype, method, wrapper, label = method) {
      if (!prototype) { coverage[label] = false; return; }
      let owner = prototype;
      let descriptor;
      while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, method)))
        owner = Object.getPrototypeOf(owner);
      if (!descriptor?.value) { coverage[label] = false; return; }
      try {
        const observed = wrapper(descriptor.value);
        Object.defineProperty(prototype, method, { ...descriptor, value: observed });
        coverage[label] = prototype[method] === observed;
      } catch { coverage[label] = false; }
    }
    function asyncCall(native, receiver, args, operation, details, onValue) {
      const operationId = ++nextOperation;
      report({ phase: "io-start", operationId, operation, ...details },
        operation === "blob-text" || operation === "blob-arrayBuffer");
      let promise;
      try { promise = Reflect.apply(native, receiver, args); }
      catch (error) {
        minimal({ phase: "io-error", operationId, operation, ...details, errorName: errorName(error) });
        throw error;
      }
      // Return the observed chain: the exact value/error reaches the caller and remains unhandled if ignored.
      return promise.then((value) => {
        const extra = onValue ? onValue(value) : undefined;
        minimal({ phase: "io-end", operationId, operation, ...details, ...extra });
        return value;
      }, (error) => {
        minimal({ phase: "io-error", operationId, operation, ...details, errorName: errorName(error) });
        throw error;
      });
    }
    const blobDetails = (blob) => ({ blobId: blobId(blob), entryId: fileEntries.get(blob) });
    for (const method of ["text", "arrayBuffer"])
      install(NativeBlob.prototype, method, (native) => function (...args) {
        return asyncCall(native, this, args, `blob-${method}`, blobDetails(this));
      }, `Blob.${method}`);
    install(NativeBlob.prototype, "slice", (native) => function (...args) {
      const result = Reflect.apply(native, this, args);
      const entryId = fileEntries.get(this);
      if (entryId) fileEntries.set(result, entryId);
      minimal({ phase: "blob-slice", parentBlobId: blobId(this), blobId: blobId(result), entryId });
      return result;
    }, "Blob.slice");
    install(NativeBlob.prototype, "stream", (native) => function (...args) {
      const result = Reflect.apply(native, this, args);
      minimal({ phase: "blob-stream-return", ...blobDetails(this) });
      return result; // No reader, tee or consumption is added.
    }, "Blob.stream");
    const readerPrototype = window.FileReader?.prototype;
    for (const method of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"])
      install(readerPrototype, method, (native) => function (...args) {
        const operationId = ++nextOperation;
        const details = blobDetails(args[0]);
        const operation = `FileReader.${method}`;
        const record = (phase) => minimal({ phase, operationId, operation, ...details,
          ...(phase === "io-error" ? { errorName: errorName(this.error) } : undefined) });
        const success = () => record("io-end");
        const failure = () => record("io-error");
        const abort = () => record("io-abort");
        const cleanup = () => {
          this.removeEventListener("load", success);
          this.removeEventListener("error", failure);
          this.removeEventListener("abort", abort);
          this.removeEventListener("loadend", cleanup);
        };
        this.addEventListener("load", success);
        this.addEventListener("error", failure);
        this.addEventListener("abort", abort);
        this.addEventListener("loadend", cleanup);
        record("io-start");
        try { return Reflect.apply(native, this, args); }
        catch (error) {
          cleanup();
          minimal({ phase: "io-error", operationId, operation, ...details, errorName: errorName(error) });
          throw error;
        }
      }, `FileReader.${method}`);
    install(window.StorageManager?.prototype, "getDirectory", (native) => function (...args) {
      return asyncCall(native, this, args, "opfs-get-root", { entryId: "entry-0" }, (handle) => {
        handleEntries.set(handle, "entry-0");
      });
    }, "StorageManager.getDirectory");
    const directoryPrototype = window.FileSystemDirectoryHandle?.prototype;
    for (const method of ["getFileHandle", "getDirectoryHandle"])
      install(directoryPrototype, method, (native) => function (...args) {
        const parentEntryId = entryFor(handleEntries, this);
        const entryId = childEntry(parentEntryId, args[0]);
        return asyncCall(native, this, args, `opfs-${method}`, { parentEntryId, entryId }, (handle) => {
          handleEntries.set(handle, entryId);
        });
      }, `Directory.${method}`);
    install(directoryPrototype, "removeEntry", (native) => function (...args) {
      const parentEntryId = entryFor(handleEntries, this);
      return asyncCall(native, this, args, "opfs-remove", {
        parentEntryId, entryId: childEntry(parentEntryId, args[0]),
      });
    }, "Directory.removeEntry");
    const filePrototype = window.FileSystemFileHandle?.prototype;
    install(filePrototype, "getFile", (native) => function (...args) {
      const entryId = entryFor(handleEntries, this);
      return asyncCall(native, this, args, "opfs-get-file", { entryId }, (file) => {
        fileEntries.set(file, entryId);
        return { blobId: blobId(file) };
      });
    }, "FileHandle.getFile");
    install(filePrototype, "createWritable", (native) => function (...args) {
      const entryId = entryFor(handleEntries, this);
      return asyncCall(native, this, args, "opfs-create-writable", { entryId }, (writer) => {
        writerEntries.set(writer, entryId);
      });
    }, "FileHandle.createWritable");
    for (const method of ["write", "close", "abort"])
      install(window.FileSystemWritableFileStream?.prototype, method, (native) => function (...args) {
        return asyncCall(native, this, args, `opfs-${method}`, {
          entryId: entryFor(writerEntries, this),
        });
      }, `Writable.${method}`);
    minimal({ phase: "read-observer-ready", coverage });

    report({ phase: "observer-ready" });
  });
}
