import { z } from "zod";
import { zodJitless } from "../zod-jitless.js";
import type {
  SecretBackendCapabilities,
  SecretBackendConfiguration,
} from "./types.js";

// This schema is also imported directly, before the worker protocol runs.
zodJitless();

/** Transient unlock input shared by the common port and its dedicated worker. */
export const bitwardenNativeUnlockInput = z.object({
  accountEmail: z.string().min(1).max(4096),
  masterPassword: z.string().min(1).max(4096),
  deviceIdentifier: z.string().uuid(),
});
export type BitwardenNativeConfiguration = SecretBackendConfiguration &
  z.infer<typeof bitwardenNativeUnlockInput>;
export const bitwardenNativeCapabilities: SecretBackendCapabilities = {
  itemKinds: ["note", "login", "secret"],
  itemFields: ["username", "url", "notes", "secret"],
  vaultBackup: { kind: "note", field: "notes", maxBytes: 480 * 1024 },
  list: true,
  get: true,
  create: true,
  update: true,
  delete: true,
  import: false,
};
