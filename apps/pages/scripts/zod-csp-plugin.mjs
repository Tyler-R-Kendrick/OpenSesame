import { fileURLToPath } from "node:url";

/** Make schema configuration a dependency, even when Rollup moves schemas. */
export function zodCsp() {
  const configuration = fileURLToPath(
    new URL(
      "../../../packages/app-core/src/lib/zod-jitless.ts",
      import.meta.url,
    ),
  );
  return {
    name: "zod-csp-configuration",
    enforce: "pre",
    transform(source, id) {
      const path = id.split("?")[0].replaceAll("\\", "/");
      if (!path.endsWith("/node_modules/zod/v4/core/core.js")) return null;
      // This import precedes core's existing util import, which is cyclic.
      // A separate manual chunk alone cannot establish evaluation order.
      return {
        code: `import ${JSON.stringify(configuration)};\n${source}`,
        map: null,
      };
    },
  };
}
