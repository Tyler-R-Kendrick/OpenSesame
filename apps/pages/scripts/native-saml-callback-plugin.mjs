/** Emit the fixed, external ACS loader only when its owning connector capability ships. */
import { fileURLToPath } from "node:url";

export function nativeSamlCallbackPlugin() {
  let included = false;
  return {
    name: "opensesame-native-saml-callback",
    apply: "build",
    configResolved(config) {
      const input = config.build.rollupOptions.input;
      const entries =
        input && Object(input) === input ? Object.values(input) : [];
      included = entries.some((entry) =>
        entry.endsWith("/auth/native-connector.html"),
      );
    },
    buildStart() {
      if (!included) return;
      this.emitFile({
        type: "chunk",
        id: fileURLToPath(
          new URL("../auth/native-saml-return.ts", import.meta.url),
        ),
        name: "native-saml",
      });
    },
  };
}
