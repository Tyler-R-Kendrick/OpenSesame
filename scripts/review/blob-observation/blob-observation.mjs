/** Transient metadata observation; native URL and Worker operations still run. */
import { appendFileSync, mkdirSync } from "node:fs";

const output = new URL("../../../../artifacts/live-join/", import.meta.url);
export async function observeBlobs(context) {
  mkdirSync(output, { recursive: true });
  const record = (entry) => appendFileSync(
    new URL("blob-observation.jsonl", output),
    `${JSON.stringify(entry)}\n`,
  );
  await context.exposeBinding("recordBlobObservation", (_source, entry) => record(entry));
  const watch = (page) => page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location()?.url ?? "";
    if (url.startsWith("blob:")) record({ phase: "console-error", url });
  });
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  await context.addInitScript(() => {
    const report = (phase, url, mime) => {
      void window.recordBlobObservation({
        phase,
        url,
        ...(mime === undefined ? {} : { mime }),
        stack: new Error().stack?.slice(0, 2000) ?? "",
      }).catch(() => {});
    };
    const create = URL.createObjectURL;
    URL.createObjectURL = function (...args) {
      const url = Reflect.apply(create, this, args);
      report("create", url, args[0]?.type ?? "");
      return url;
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (...args) {
      const result = Reflect.apply(revoke, this, args);
      report("revoke", String(args[0]));
      return result;
    };
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget);
        report("worker", String(args[0]));
        return worker;
      },
    });
  });
}
