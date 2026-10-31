/** Compile owned deployment metadata without importing public assets as modules. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";
import {
  manifestPath,
  validateStaticAuth,
} from "../../../scripts/lib/static-auth-artifacts.mjs";
import { securityProfile } from "./security-profile.mjs";

export const SHELL_BUILD_METADATA = "virtual:opensesame-shell-build";
const resolvedModule = `\0${SHELL_BUILD_METADATA}`;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readStampedProfile(file) {
  const stamped = JSON.parse(readFileSync(file, "utf8"));
  if (
    stamped?.version !== 1 ||
    (stamped.headerSecurity !== true && stamped.headerSecurity !== false)
  )
    throw new Error("Invalid stamped security profile");
  const checked = securityProfile({
    PAGES_DEPLOYMENT_PROFILE: stamped.profile,
    PAGES_CANONICAL_ORIGIN: stamped.canonicalOrigin,
    PAGES_HEADER_SECURITY: stamped.headerSecurity ? "1" : "0",
  });
  const keys = Object.keys(checked);
  if (
    Object.keys(stamped).length !== keys.length ||
    keys.some((key) => stamped[key] !== checked[key])
  )
    throw new Error("Invalid stamped security profile");
  return checked;
}

export function shellBuildMetadata(root = repositoryRoot) {
  const profileFile = join(root, "apps/pages/public/security-profile.json");
  const manifestFile = join(root, manifestPath);
  const watched = new Set();
  let devServer;
  return {
    name: "opensesame-shell-build-metadata",
    configureServer(server) {
      devServer = server;
    },
    watchChange(file) {
      if (!watched.has(normalizePath(file))) return;
      const module = devServer?.moduleGraph.getModuleById(resolvedModule);
      if (module) devServer.moduleGraph.invalidateModule(module);
    },
    resolveId(id) {
      if (id === SHELL_BUILD_METADATA) return resolvedModule;
    },
    load(id) {
      if (id !== resolvedModule) return;
      const watch = (file) => {
        watched.add(normalizePath(resolve(file)));
        this.addWatchFile(file);
      };
      watch(profileFile);
      watch(manifestFile);
      watch(join(root, "packages/static-auth/package.json"));
      watch(join(root, "biome.json"));
      const stamped = readStampedProfile(profileFile);
      const release = validateStaticAuth(root);
      for (const artifact of release.artifacts) {
        watch(join(root, artifact.path));
        watch(join(root, `${artifact.path}.sha384`));
      }
      return [
        `export const SECURITY_PROFILE = ${JSON.stringify(stamped)};`,
        `export const STATIC_AUTH = ${JSON.stringify({ version: release.version, sri: release.sri })};`,
      ].join("\n");
    },
    handleHotUpdate({ file, server }) {
      if (!watched.has(normalizePath(file))) return;
      const module = server.moduleGraph.getModuleById(resolvedModule);
      if (!module) return;
      server.moduleGraph.invalidateModule(module);
      return [module];
    },
  };
}
