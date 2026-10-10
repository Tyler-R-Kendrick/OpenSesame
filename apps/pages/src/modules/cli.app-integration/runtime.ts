/**
 * `cli.app-integration` — polls the local daemon for pending CLI reveal
 * requests and draws the 1Password-style Authorize CLI sheet while the vault
 * is unlocked (ADR 0186).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { CliAuthorizeHost } from "./CliAuthorizeHost.js";

export const capabilityRuntime: CapabilityRuntime = {
  activate(activation) {
    activation.register("shell-wrapper", {
      id: "cli-app-integration",
      Wrapper: CliAuthorizeHost,
      order: 15,
    });
    return activation.handle();
  },
};
