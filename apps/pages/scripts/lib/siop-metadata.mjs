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
 * GitHub Pages build knows it: it is the upstream project's, and a build in
 * GitHub Actions knows whose project it is from `GITHUB_REPOSITORY_OWNER`.
 * Anything else must say so with `PAGES_CANONICAL_ORIGIN`:
 *
 *   - a fork built in Actions (another owner), with no origin of its own;
 *   - a fork that names the upstream project's origin as its own;
 *   - any build under another base path, with no origin of its own.
 *
 * Each publishes no document, and warns why, rather than one naming an issuer
 * it is not. A build outside Actions has no owner to read and names what
 * `securityProfile` names (the upstream project's unless told otherwise): a
 * fork that builds by hand and publishes by hand sets the variable.
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

/** The shipped deployment's origin, and the account that owns it. */
export const SHIPPED_ORIGIN = "https://tyler-r-kendrick.github.io";
const UPSTREAM_OWNER = new URL(SHIPPED_ORIGIN).hostname.split(".")[0];

/**
 * The origin and base path the document names, or why there is none.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} base the build's public base path
 */
export function siopMetadataLocation(env, base) {
  // A variable that is set but blank (an unset repository variable expands to
  // that) says nothing.
  const said = env.PAGES_CANONICAL_ORIGIN?.trim();
  const { canonicalOrigin } = securityProfile({
    ...env,
    PAGES_CANONICAL_ORIGIN: said === "" ? undefined : said,
  });
  const explicit = said !== undefined && said !== "";
  const owner = env.GITHUB_REPOSITORY_OWNER?.trim().toLowerCase();
  const fork = owner !== undefined && owner !== "" && owner !== UPSTREAM_OWNER;
  const not = `${SIOP_METADATA_FILE} is not published`;
  if (!explicit && base !== SHIPPED_BASE) {
    return {
      skip: `no PAGES_CANONICAL_ORIGIN for a build under ${base}: ${not}`,
    };
  }
  if (!explicit && fork) {
    return {
      skip: `built for ${owner}, not ${UPSTREAM_OWNER}, with no PAGES_CANONICAL_ORIGIN of its own: ${not}`,
    };
  }
  if (explicit && fork && canonicalOrigin === SHIPPED_ORIGIN) {
    return {
      skip: `PAGES_CANONICAL_ORIGIN names ${UPSTREAM_OWNER}'s origin in a build for ${owner}: ${not}`,
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
