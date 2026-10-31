/** Closed, bounded source discovery for the reviewed authentication/exposure lanes. */
import { createHash } from "node:crypto";
import { CORE_CONTRACTS } from "./exposure-contracts.mjs";
import { LOCAL_VAULT_CONTRACT } from "./exposure-local-vault.mjs";
import { NATIVE_PROVIDER_CONTRACT } from "./exposure-native-provider.mjs";

const TEST =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|_tests?(?:_[^/]+)?\.rs$|\/tests\.rs$|\/(?:__tests__|tests|fixtures|test_support|test-support)\/)/u;
const SCOPES = Object.freeze({
  "local-vault-activation": [
    /^packages\/app-core\/src\/lib\/(?:vfs|kv|local-iam|local-directory|local-credentials|local-passkey|local-passkeys|local-sessions|trusted-unlock|projects|orgs|idp-registry)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/device-identity-(?:carry|key|record-data|trust)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/secret-fs\/install(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/secret-fs\/(?:files|memory|filesystem|s3|resilient|vfs-files)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/node\/secret-files(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/deadman\/(?:state|authentication|fence|keys|crypto|arm)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/vault\/(?:store-(?:unlock|operation|primary|second-step|scope|state|presentation|view|body|seal|write|header|device|preferences)|vault-shared-locks|passkey-unlock|protector-unlock|primary-unwrap|second-step-guard|recovery-codes|remote-code|unlock-(?:methods|factor|attempts)|tomb-migration|seal-rebind|prefs-io|lock-events)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/vault\/self-authenticator(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/vault\/authentication-storage(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/app-core\/src\/lib\/vault\/protection\/(?:adapter|session-guard|browser-service|browser-operation-data|browser-operation-check|manifest-auth|unlock-protector-open)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/auth-upstream\/src\/(?:browser|passkey-verification|simplewebauthn)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/sdk-browser\/src\/webauthn(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/vault-core\/src\/factor-configuration(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
  ],
  "native-provider-custody": [
    /^packages\/app-core\/src\/lib\/native-(?:key|bitwarden|tailscale|bridge)(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
    /^packages\/app-core\/src\/lib\/native-(?:connector-(?:transport|store|schema|view|binding|drivers|lifecycle|availability)|authorization-transport|bounded-body|api-(?:authority|http|verify|connectors|operations?|requests?|resources?|admission|proof|target|auth)|browser-policy|oauth-(?:session|resource|client-(?:config|contract|scopes|exchange|update)|commit|errors|http))(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
    /^packages\/app-core\/src\/lib\/(?:connector-bridge(?:-client)?|device-connector-records|vault-credential-custody)(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
    /^packages\/app-core\/src\/lib\/secret-backends\/runtime-owners(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
    /^packages\/sdk-browser\/src\/pkce(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
    /^apps\/pages\/src\/modules\/connectors\.external\/(?:native-api-runtime|native-runtime|native-oauth-resource-runtime|native-oauth-runtime|bridge-runtime|browser-node-transport)(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
  ],
  "hosted-drop": [
    /^packages\/control-plane\/src\/routes\/claim[^/]*\.ts$/u,
    /^packages\/control-plane\/src\/repos\/(?:durable-map|security-maps|durable-claim-store)\.ts$/u,
    /^packages\/claims\/src\//u,
    /^packages\/os-domain\/src\/crypto\/claim-token(?:\.ts|\/.*\.ts)$/u,
  ],
  "account-totp": [
    /^packages\/control-plane\/src\/routes\/(?:mfa[^/]*|interaction-activation[^/]*)\.ts$/u,
  ],
  "portable-drop": [
    /^packages\/app-core\/src\/lib\/vault\/(?:portable-drop[^/]*|drop(?:-transport)?|outbound-drops)\.ts$/u,
    /^packages\/app-core\/src\/lib\/claims\/(?:drop-open|arrival|link|stash|route-model)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/ceremony-kit\/src\/(?:claim-link|claim-stash)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
    /^packages\/vault-core\/src\/(?:drop-format|crypto|bytes)(?:-[^/]+)?(?:\.ts|\/.*\.ts)$/u,
  ],
  "est-enrollment": [
    /^crates\/gateway\/src\/routes\/est[^/]*(?:\.rs|\/.*\.rs)$/u,
    /^crates\/storage\/src\/est[^/]*(?:\.rs|\/.*\.rs)$/u,
  ],
  "host-admission": [/^crates\/gateway\/src\/transport\/.*\.rs$/u],
  bitwarden: [
    /^crates\/bitwarden-server\/src\/.*\.rs$/u,
    /^crates\/provider-bitwarden\/src\/api(?:\.rs|\/.*\.rs)$/u,
  ],
  "signing-keys": [/^packages\/oauth-provider\/src\/keys\//u],
  "share-lifecycle": [
    /^apps\/pages\/src\/sections\/access\/SentDropsPanel\.tsx$/u,
    /^apps\/pages\/src\/sections\/vault\/(?:ShareForm|DropTtl|drop-card-fields)\.tsx$/u,
    /^apps\/pages\/src\/modules\/identity\.ceremonies\/(?:DropClaimScreen|ClaimRoute|ClaimDifferentLink)(?:-[^/]+)?(?:\.tsx?|\/.*\.tsx?)$/u,
  ],
});

const WIRING = Object.freeze({
  ...Object.fromEntries(
    NATIVE_PROVIDER_CONTRACT.implementation.map((path) => [
      path,
      NATIVE_PROVIDER_CONTRACT.area,
    ]),
  ),
  ...Object.fromEntries(
    LOCAL_VAULT_CONTRACT.implementation.map((path) => [
      path,
      LOCAL_VAULT_CONTRACT.area,
    ]),
  ),
  "packages/control-plane/package.json": "hosted-drop",
  "packages/control-plane/src/create-app.ts": "hosted-drop",
  "packages/control-plane/src/state.ts": "account-totp",
  "packages/contracts/src/claims.ts": "hosted-drop",
  "packages/os-domain/package.json": "hosted-drop",
  "packages/os-domain/src/index.ts": "hosted-drop",
  "packages/os-domain/src/json.ts": "hosted-drop",
  "packages/os-domain/src/crypto/claim-token.ts": "hosted-drop",
  "packages/app-core/package.json": "portable-drop",
  "packages/ceremony-kit/package.json": "portable-drop",
  "packages/ceremony-kit/src/index.ts": "portable-drop",
  "packages/ceremony-kit/src/links.ts": "portable-drop",
  "packages/vault-core/package.json": "portable-drop",
  "packages/vault-core/src/index.ts": "portable-drop",
  "packages/vault-core/src/crypto.ts": "portable-drop",
  "packages/vault-core/src/bytes.ts": "portable-drop",
  "packages/oauth-provider/src/index.ts": "signing-keys",
  "packages/oauth-provider/src/env.ts": "signing-keys",
  "crates/gateway/src/lib.rs": "host-admission",
  "crates/gateway/src/config.rs": "host-admission",
  "crates/gateway/src/bootstrap.rs": "host-admission",
  "crates/gateway/src/routes/mod.rs": "host-admission",
  "crates/storage/src/migrations.rs": "est-enrollment",
  "crates/domain/src/lib.rs": "est-enrollment",
  "crates/domain/src/transport/mod.rs": "est-enrollment",
  "crates/domain/src/transport/evidence.rs": "est-enrollment",
  "crates/domain/src/transport/policy.rs": "est-enrollment",
  "crates/domain/src/transport/attest.rs": "est-enrollment",
  "crates/storage/migrations/0057_est_passphrase_budget.sql": "est-enrollment",
  "crates/storage/migrations/0059_est_source_budgets.sql": "est-enrollment",
  "crates/storage/migrations/0058_bitwarden_attempt_budgets.sql": "bitwarden",
  "crates/bitwarden-server/Cargo.toml": "bitwarden",
  "crates/provider-bitwarden/Cargo.toml": "bitwarden",
  "crates/provider-bitwarden/src/lib.rs": "bitwarden",
});

export const areaNames = Object.freeze(Object.keys(SCOPES));
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function sourceArea(path) {
  if (TEST.test(path)) return undefined;
  if (Object.hasOwn(WIRING, path)) return WIRING[path];
  return Object.entries(SCOPES).find(([, patterns]) =>
    patterns.some((pattern) => pattern.test(path)),
  )?.[0];
}

function requiredBindings(policy) {
  const errors = [];
  for (const [id, contract] of Object.entries(CORE_CONTRACTS)) {
    const surface = policy.surfaces.find((row) => row.id === id);
    if (!surface) continue;
    for (const role of ["implementation", "regressions"]) {
      for (const path of contract[role]) {
        if (!surface[role].includes(path))
          errors.push(
            `EM-BINDING: ${id} is missing its ${role} binding ${path}`,
          );
      }
    }
  }
  return errors;
}

function fingerprintViolations(sources, snapshot) {
  const errors = [];
  for (const [path, digest] of Object.entries(sources)) {
    try {
      if (!/^100(?:644|755)$/u.test(snapshot.mode(path)))
        throw new Error("source is not a regular file");
      if (sha256(snapshot.read(path)) !== digest)
        errors.push(
          `EM-DRIFT: reviewed implementation changed: ${path}; review and run its regressions before updating the matrix`,
        );
    } catch (error) {
      errors.push(`EM-SOURCE: ${path}: ${error.message}`);
    }
  }
  return errors;
}

/** Every discovered file needs an explicit surface binding, not just a saved hash. */
export function coverageViolations(policy, snapshot) {
  const errors = requiredBindings(policy);
  const assigned = new Map();
  const custodySources = new Map(
    [LOCAL_VAULT_CONTRACT, NATIVE_PROVIDER_CONTRACT].map((contract) => [
      contract.area,
      new Set(
        policy.surfaces.find((row) => row.id === contract.area)?.implementation,
      ),
    ]),
  );
  for (const row of policy.surfaces) {
    if (!areaNames.includes(row.area))
      errors.push(`EM-COVERAGE: unknown area for ${row.id}`);
    for (const path of row.implementation) {
      const owners = assigned.get(path) ?? new Set();
      owners.add(row.area);
      assigned.set(path, owners);
    }
  }
  const paths = new Set(snapshot.paths());
  for (const path of Object.keys(WIRING)) {
    if (!paths.has(path))
      errors.push(`EM-COVERAGE: missing entrypoint/storage wiring ${path}`);
  }
  for (const path of paths) {
    const area = sourceArea(path);
    if (!area) continue;
    if (
      !Object.hasOwn(policy.sources, path) ||
      !assigned.get(path)?.has(area) ||
      (custodySources.has(area) && !custodySources.get(area).has(path))
    )
      errors.push(
        `EM-COVERAGE: unclassified protected source ${path}; review its observer, artifacts and enforcement`,
      );
  }
  return [...errors, ...fingerprintViolations(policy.sources, snapshot)];
}
