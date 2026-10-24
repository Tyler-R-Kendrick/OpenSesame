export const start = () =>
  new Worker(
    new URL(
      "../../src/modules/networking.tailnet/browser/worker.ts",
      import.meta.url,
    ),
    { type: "module" },
  );
