/**
 * Vite plugin: publish `siop-metadata.json` beside the app (ADR 0161).
 *
 * A build emits it into `dist/` at the base path, which is the one place a
 * GitHub project page can serve it. It deliberately does not write
 * `.well-known/openid-configuration`: the document is not OpenID Connect
 * Discovery, and `actions/upload-pages-artifact` drops every dot-directory
 * anyway (ADR 0161 §3). The dev server answers the same path from the origin
 * it is reached on, so a relying-party developer can try discovery locally.
 *
 * Owned by `identity.siop` (`PUBLIC_FILE_OWNERSHIP`), so a hardened build that
 * excludes the capability prunes it with the rest of its files.
 */
import {
  SIOP_METADATA_FILE,
  siopMetadataLocation,
  siopMetadataText,
} from "./lib/siop-metadata.mjs";

/** @param {{ env?: Record<string, string | undefined> }} [options] */
export function siopMetadata(options = {}) {
  const env = options.env ?? process.env;
  let base = "/";
  return {
    name: "opensesame-siop-metadata",
    configResolved(config) {
      base = config.base;
    },
    async generateBundle() {
      if (env.VITEST) return;
      const where = siopMetadataLocation(env, base);
      if (where.skip) {
        this.warn(where.skip);
        return;
      }
      this.emitFile({
        type: "asset",
        fileName: SIOP_METADATA_FILE,
        source: await siopMetadataText(where),
      });
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path !== `${base}${SIOP_METADATA_FILE}`) return next();
        try {
          const origin = `http://${req.headers.host}`;
          const body = await siopMetadataText({ origin, basePath: base });
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("access-control-allow-origin", "*");
          res.end(body);
        } catch {
          // A host that is not an allowed issuer (a LAN address over plain
          // http) has no document; the page's own fallback is not JSON.
          res.statusCode = 404;
          res.end("not found");
        }
      });
    },
  };
}
