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
      import {connectPlan} from './packages/app-core/src/lib/connect-plan.ts';
      import {nativeBrowserOAuthProfile} from './packages/app-core/src/lib/native-browser-oauth-profile.ts';
      import {nativeProviderDescriptor} from './apps/pages/src/sections/connections/connect/native-provider-descriptor.ts';
      import {nativeKeyDriverFor} from './packages/app-core/src/lib/native-key-drivers.ts';
      import {nativeKeyDescriptor} from './apps/pages/src/sections/connections/connect/native-key-descriptor.ts';
      import {nativeS3Descriptor} from './apps/pages/src/sections/connections/connect/native-s3-descriptor.ts';
      import {getBundledProviders} from './packages/app-core/src/lib/embedded-catalog.ts';
      export {CONNECT_PLAN_JSON as connectPlanJson} from './packages/app-core/src/lib/connect-presets.generated.ts';
      import {mergeVercelCatalog} from './packages/app-core/src/lib/vercel-connect-catalog.ts';
      import {isConnectionCatalogProvider} from './packages/app-core/src/lib/catalog-provider.ts';
      import {isAiModelProvider} from './packages/app-core/src/lib/ai-model-provider.ts';
      import {aiConnectionDraft,aiConnectionPreset,aiConnectionFamilies} from './packages/app-core/src/lib/ai-connections/presets.ts';
      export {isAiImageFamily} from './packages/app-core/src/lib/ai-connections/types.ts';
      import {nativeBrowserMcpPolicy,bindNativeBrowserPolicyOrigin} from './packages/app-core/src/lib/native-browser-policy.ts';
      // Schema projection only: availability does not authorize a browser road.
      // The real browser still owns runtime/transport admission and all requests.
      export function authFieldMethods(providerId) {
        const provider = connectionRouteProvider(all, providerId);
        const keyed = nativeKeyDriverFor(provider?.id ?? providerId);
        if (provider && keyed) return nativeKeyDescriptor(provider, true, keyed.ui(provider.id)).methods;
        if (provider?.id === 's3') return nativeS3Descriptor(provider, true).methods;
        const plan = connectPlan(provider?.id ?? providerId);
        if (!plan || plan.refused) return [];
        const availability = {
          callbackUrl: 'https://opensesame-labs.github.io/OpenSesame/auth/native-connector.html',
          apiKey: {available: true},
          oauth: {available: true, registeredAvailable: true, profile: nativeBrowserOAuthProfile(providerId) ?? undefined},
          mcp: {available: true, actor: 'user'},
        };
        const methods = nativeProviderDescriptor(plan, availability).methods;
        // Isolation can disable Google's popup while registered OAuth stays configurable.
        return providerId === 'google' ? [...methods, ...nativeProviderDescriptor(plan, {
          ...availability, oauth: {...availability.oauth, available: false},
        }).methods.filter(method => method.id === 'oauth')] : methods;
      }
      const releaseOrigin=bindNativeBrowserPolicyOrigin(()=> 'https://opensesame-labs.github.io');
      export const auditedAdobeAdmission=nativeBrowserMcpPolicy('adobe');
      releaseOrigin();
      import {curatedCatalogProviders} from './apps/pages/src/sections/connections/catalog-selection.ts';
      import {connectionRouteProvider} from './packages/app-core/src/sections/connections/provider-route.ts';
      export const all = mergeVercelCatalog(getBundledProviders()).filter(isConnectionCatalogProvider);
      export function routeProvider(providerId) { return connectionRouteProvider(all, providerId); }
      export const listed = curatedCatalogProviders(all, {includeFeatured: true, includeFamilies: true});
      export const aiModelProviderIds = all.filter(isAiModelProvider).map(provider => provider.id);
      export const sharedAiPresets = all.flatMap(provider => {
        const preset = aiConnectionPreset(provider.id);
        return preset ? [{...preset,authentication:aiConnectionDraft(provider.id).authentication,families:aiConnectionFamilies(provider.id).map(family => family.id)}] : [];
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
/** Match the production route's exact-id then canonical-alias lookup. */
export function nativeCanonicalRouteProvider(providerId) {
  const provider = source.routeProvider(providerId);
  return provider ? { id: provider.id, name: provider.displayName } : null;
}
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

/** Canonical field schemas only; never a substitute for executable admission. */
export const nativeAuthFieldMethods = source.authFieldMethods;

/** The same image-family discriminator used by the rendered shared form. */
export const nativeIsAiImageFamily = source.isAiImageFamily;
