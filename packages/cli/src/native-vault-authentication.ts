import type { PhysicalAuthenticationPort } from "@opensesame/app-core/lib/vault/physical-authentication-port.js";
import { snapshot, unavailable } from "./native-vault-data.js";

import type { NativeVaultContext } from "./native-vault-context.js";

export function authenticationPort({ capture }: NativeVaultContext) {
  const authentication: PhysicalAuthenticationPort = {
    bodyFormat: "node-projection-v1",
    async capture(tomb, original) {
      const held = capture(original, tomb);
      return {
        ...held,
        async read() {
          held.check();
          const value = await snapshot(held.process, tomb);
          held.check();
          if (value.deleted) unavailable();
          return value.snapshot ?? { tomb, header: null, body: null };
        },
      };
    },
  };

  return authentication;
}
