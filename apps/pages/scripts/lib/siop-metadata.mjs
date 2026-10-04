/**
 * The SIOP metadata document a build publishes (ADR 0161): where it would be
 * served from, and its bytes.
 *
 * The bytes come from `@opensesame/siop-v2` (`serializePagesSiopMetadata`),
 * which derives them from `STATIC_SIOP_METADATA` (ADR 0139). That module is
 * TypeScript, so it is loaded through Vite's own module pipeline, the way the
 * capability inventory is (`capability-compose-state.mjs`), never copied.
 *
 * Which origin to name is the part a build cannot always know. The shipped
 * GitHub Pages build knows it (`securityProfile`'s default, the project the
 * repository publishes). Any other deployment must say so with
 * `PAGES_CANONICAL_ORIGIN`; one that does not, and builds under another base
 * path, publishes no document rather than one naming an issuer it is not.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securityProfile } from "../security-profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "../..");

/** The file's published name; the same constant `siop-v2` exports. */
export const SIOP_METADATA_FILE = "siop-metadata.json";

/** The base path of the shipped GitHub Pages deployment. */
export const SHIPPED_BASE = "/OpenSesame/";

/**
 * The origin and base path the document names, or why there is none.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} base the build's public base path
 */
export function siopMetadataLocation(env, base) {
  const { canonicalOrigin } = securityProfile(env);
  const explicit = Boolean(env.PAGES_CANONICAL_ORIGIN?.trim());
  if (!explicit && base !== SHIPPED_BASE) {
    return {
      skip: `no PAGES_CANONICAL_ORIGIN for a build under ${base}: ${SIOP_METADATA_FILE} is not published`,
    };
  }
  return { origin: canonicalOrigin, basePath: base };
}

/** `@opensesame/siop-v2`'s discovery module, loaded through Vite. */
export async function loadDiscovery(appRoot = APP_ROOT) {
  const { createServer } = await import("vite");
  const repo = resolve(appRoot, "../..");
  const server = await createServer({
    configFile: false,
    envFile: false,
    root: appRoot,
    logLevel: "error",
    appType: "custom",
    resolve: {
      alias: {
        "@opensesame/os-domain": join(
          repo,
          "packages/os-domain/src/browser.ts",
        ),
      },
    },
    ssr: { noExternal: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  try {
    return await server.ssrLoadModule(
      join(repo, "packages/siop-v2/src/discovery.ts"),
    );
  } finally {
    await server.close();
  }
}

/**
 * The bytes a deployment at `where` publishes.
 *
 * @param {{ origin: string, basePath: string }} where
 */
export async function siopMetadataText(where, appRoot = APP_ROOT) {
  const discovery = await loadDiscovery(appRoot);
  if (discovery.SIOP_METADATA_FILE !== SIOP_METADATA_FILE) {
    throw new Error("siop-v2 and the build disagree on the metadata file name");
  }
  return discovery.serializePagesSiopMetadata(where);
}
