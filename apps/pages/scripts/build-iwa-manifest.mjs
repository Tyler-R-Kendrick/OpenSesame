/**
 * Write the Isolated Web App manifest into the built bundle.
 *
 * IWA discovery is not the PWA manifest link: the browser reads
 * `.well-known/manifest.webmanifest` from the signed bundle. The version is
 * build metadata, not a runtime setting, because the update manifest compares
 * it before installing anything.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, process.env.IWA_OUT_DIR ?? "dist-iwa");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = process.env.IWA_VERSION ?? pkg.version;
if (!/^(\d+\.)*\d+$/u.test(version))
  throw new Error("IWA_VERSION must be one or more integers separated by dots");

const update = process.env.IWA_UPDATE_MANIFEST_URL;
if (update !== undefined) {
  const url = new URL(update);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && url.hostname === "localhost")
  )
    throw new Error("IWA_UPDATE_MANIFEST_URL must be HTTPS or localhost");
}

const manifest = {
  name: "OpenSesame",
  short_name: "OpenSesame",
  description:
    "End-to-end-encrypted vault for passwords, passkeys, and agent secrets",
  version,
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: "#fafafa",
  background_color: "#fafafa",
  icons: [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ],
  permissions_policy: {
    "direct-sockets": ["self"],
    "direct-sockets-multicast": ["self"],
    "direct-sockets-private": ["self"],
    "local-network": ["self"],
    "loopback-network": ["self"],
    "cross-origin-isolated": ["self"],
    "local-peer-to-peer": ["self"],
  },
};
if (update !== undefined) manifest.update_manifest_url = update;
const target = join(out, ".well-known", "manifest.webmanifest");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`IWA manifest: ${target} (version ${version})`);
