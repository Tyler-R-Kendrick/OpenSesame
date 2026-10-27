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
    const blobIds = new WeakMap();
    let nextBlob = 0;
    const blobId = (blob) => {
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
    const report = (entry) => {
      void window.recordBlobObservation({
        ...entry,
        browserAtUnixMs: performance.timeOrigin + performance.now(),
        documentTimeOriginMs: performance.timeOrigin,
        documentUrl: withoutRouteData(location.href),
        stack: new Error().stack?.replace(/[?#][^\s)]*/g, "").slice(0, 2000) ?? "",
      }).catch(() => {});
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
    report({ phase: "observer-ready" });
  });
}
