/** Public browser OAuth client metadata is deployment data, never a client secret. */
import { securityProfile } from "./security-profile.mjs";

export function nativeClientMetadata(base, env = process.env) {
  const { canonicalOrigin } = securityProfile(env);
  const origin = new URL(canonicalOrigin);
  if (origin.protocol !== "https:") return null;
  const deployment = new URL(base, `${origin.origin}/`);
  if (
    deployment.origin !== origin.origin ||
    deployment.search ||
    deployment.hash
  )
    throw new Error("Invalid native connector deployment base");
  const clientId = new URL("auth/native-client.json", deployment).href;
  return {
    client_id: clientId,
    client_name: "OpenSesame",
    client_uri: deployment.href,
    application_type: "web",
    redirect_uris: [new URL("auth/native-connector.html", deployment).href],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function nativeClientMetadataPlugin(base, env = process.env) {
  return {
    name: "opensesame-native-client-metadata",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (!Object.hasOwn(bundle, "auth/native-connector.html")) return;
        const metadata = nativeClientMetadata(base, env);
        if (!metadata) return;
        this.emitFile({
          type: "asset",
          fileName: "auth/native-client.json",
          source: `${JSON.stringify(metadata, null, 2)}\n`,
        });
      },
    },
  };
}
