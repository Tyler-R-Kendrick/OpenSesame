/** Read-only canonical source projection; no connector runtime or browser state is replaced. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);
const require = createRequire(new URL("packages/app-core/package.json", root));
const { buildSync } = require("esbuild");
// The shared policy graph reads its public deployment env while importing.
// This host exists only in the Node inventory process, never in the app under test.
globalThis.__opensesameAppCoreHost = {
  env: { BASE_URL: process.env.VITE_BASE ?? "/OpenSesame/", DEV: false },
};
const projection = buildSync({
  stdin: {
    contents: `
      import {getBundledProviders} from './packages/app-core/src/lib/embedded-catalog.ts';
      export {CONNECT_PLAN_JSON as connectPlanJson} from './packages/app-core/src/lib/connect-presets.generated.ts';
      import {mergeVercelCatalog} from './packages/app-core/src/lib/vercel-connect-catalog.ts';
      import {isConnectionCatalogProvider} from './packages/app-core/src/lib/catalog-provider.ts';
      import {catalogPageSections} from './apps/pages/src/sections/connections/page-tree.ts';
      export const all = mergeVercelCatalog(getBundledProviders()).filter(isConnectionCatalogProvider);
      export const listed = catalogPageSections(all).flatMap(section => section.items ?? []);
    `,
    resolveDir: fileURLToPath(root),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const source = await import(
  `data:text/javascript;base64,${Buffer.from(projection.outputFiles[0].text).toString("base64")}`
);
export const NATIVE_CANONICAL_PROVIDERS = source.all.map((provider) => ({
  id: provider.id,
  name: provider.displayName,
}));
export const NATIVE_CANONICAL_CATALOG_IDS = source.listed.map((row) => row.id);
export const NATIVE_CONNECT_PLAN_JSON = source.connectPlanJson;
