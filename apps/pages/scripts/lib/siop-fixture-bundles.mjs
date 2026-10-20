/** Build the verifier and IAM fixture used by the real SIOP browser journey. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export async function bundleVerify(root, out) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    define: {
      "process.env.NODE_DEBUG_NATIVE": "false",
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: {
        "@opensesame/os-domain": `${root}/packages/os-domain/src/browser.ts`,
      },
    },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: fileURLToPath(
          new URL("../fixtures/siop-verify.ts", import.meta.url),
        ),
        name: "SiopVerify",
        formats: ["es"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((file) => file.type === "chunk");
  if (!chunk) throw new Error("SIOP verify bundle missing");
  const modPath = `${out}/siop-verify.mjs`;
  fs.writeFileSync(modPath, chunk.code);
  return import(`${modPath}?v=${Date.now()}`);
}

export async function bundleFixture(root) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    define: {
      "process.env.NODE_DEBUG_NATIVE": "false",
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: {
        "@opensesame/os-domain": `${root}/packages/os-domain/src/browser.ts`,
      },
    },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: fileURLToPath(
          new URL("../fixtures/siop-iam.ts", import.meta.url),
        ),
        name: "SiopIamFixture",
        formats: ["iife"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  return output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
}
