import { createHash } from "node:crypto";
import { type JsonObject, isString } from "../json.js";
import { canonicalize } from "./canonical.js";

export { canonicalize };

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(isString(data) ? Buffer.from(data, "utf8") : Buffer.from(data));
  return `sha256:${h.digest("hex")}`;
}

export function digestManifest(manifest: JsonObject): string {
  return sha256Hex(canonicalize(manifest));
}
