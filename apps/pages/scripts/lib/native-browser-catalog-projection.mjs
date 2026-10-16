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
      import {isAiModelProvider} from './packages/app-core/src/lib/ai-model-provider.ts';
      import {aiConnectionPreset,aiConnectionFamilies} from './packages/app-core/src/lib/ai-connections/presets.ts';
      import {nativeBrowserMcpPolicy,bindNativeBrowserPolicyOrigin} from './packages/app-core/src/lib/native-browser-policy.ts';
      const releaseOrigin=bindNativeBrowserPolicyOrigin(()=> 'https://tyler-r-kendrick.github.io');
      export const auditedAdobeAdmission=nativeBrowserMcpPolicy('adobe');
      releaseOrigin();
      import {catalogPageSections} from './apps/pages/src/sections/connections/page-tree.ts';
      export const all = mergeVercelCatalog(getBundledProviders()).filter(isConnectionCatalogProvider);
      export const listed = catalogPageSections(all).flatMap(section => section.items ?? []);
      export const aiModelProviderIds = all.filter(isAiModelProvider).map(provider => provider.id);
      export const sharedAiPresets = all.flatMap(provider => {
        const preset = aiConnectionPreset(provider.id);
        return preset ? [{...preset,families:aiConnectionFamilies(provider.id).map(family => family.id)}] : [];
      });
    `,
    resolveDir: fileURLToPath(root),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
// The bundle below is imported from a data: URL, where no `require`
// binding exists. Bundled CommonJS (yaml via the contracts barrel, kept
// once any live module defeats tree-shaking) calls require("process") and
// require("buffer") through esbuild's __require shim, which throws
// 'Dynamic require ... is not supported' without a real require. Lend this
// harness module's own require (bound to a file: URL, unlike the data: URL
// inside the bundle where createRequire would throw) so evaluation matches
// a file import; everything else is bundled, so only builtin requires occur.
globalThis.require ??= createRequire(import.meta.url);
const source = await import(
  `data:text/javascript;base64,${Buffer.from(projection.outputFiles[0].text).toString("base64")}`
);
export const NATIVE_CANONICAL_PROVIDERS = source.all.map((provider) => ({
  id: provider.id,
  name: provider.displayName,
}));
export const NATIVE_CANONICAL_CATALOG_IDS = source.listed.map((row) => row.id);
export const NATIVE_CONNECT_PLAN_JSON = source.connectPlanJson;

/**
 * Model providers: a first connection from the Add catalog opens the Add sheet
 * (ADR 0192), so these ids are walked as a sheet there and as a page from
 * Settings, which never opens one.
 */
export const NATIVE_AI_MODEL_PROVIDER_IDS = new Set(source.aiModelProviderIds);

/** Public defaults only; the browser's actual form must agree with its provider. */
export const NATIVE_SHARED_AI_PRESETS = new Map(
  source.sharedAiPresets.map((preset) => [preset.providerId, preset]),
);

/** Synthetic allowed-origin protocols never waive the real measured GH admission. */
export const NATIVE_AUDITED_ADOBE_ADMISSION = source.auditedAdobeAdmission;
