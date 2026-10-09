/** Fresh operator deployment; the shared-origin demo's authority policy stays intact. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { boundPort } from "../../../scripts/test/provider-auth-services.mjs";

export async function buildProviderAuthDeployment({ root, base, out }) {
  const port = await boundPort();
  const hostname = "provider-auth.opensesame.test";
  const origin = `https://${hostname}:${port}`;
  const pages = path.join(root, "apps/pages");
  const dist = path.join(out, "build-dedicated");
  const log = fs.openSync(path.join(out, "operator-build.log"), "w", 0o600);
  try {
    execFileSync(
      process.execPath,
      [
        path.join(pages, "scripts/stamped-build.mjs"),
        'vite build --outDir "$PAGES_PROVIDER_AUTH_DIST" --emptyOutDir',
      ],
      {
        cwd: pages,
        env: {
          ...process.env,
          VITE_BASE: base,
          PAGES_DEPLOYMENT_PROFILE: "dedicated_origin",
          PAGES_CANONICAL_ORIGIN: origin,
          PAGES_HEADER_SECURITY: "1",
          PAGES_PROVIDER_AUTH_DIST: dist,
          PATH: `${path.join(root, "node_modules/.bin")}:${process.env.PATH}`,
        },
        stdio: ["ignore", log, log],
        timeout: 240000,
      },
    );
  } finally {
    fs.closeSync(log);
  }
  return {
    dist,
    hostname,
    port,
    origin,
  };
}
