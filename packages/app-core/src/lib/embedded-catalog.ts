import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import parity from "../../../../connectors/fnox-parity.json";
import type {
  ConfigurationField,
  Provider,
  ProviderCategory,
} from "./connections.js";
import {
  BUNDLED_REVISION,
  CATEGORY,
  FIELDS,
  HOST,
  IDENTITY,
  LLM,
  NAMES,
  NETWORKING,
  WALLET,
} from "./embedded-catalog-data.js";
import { bundledGitProvider } from "./embedded-git.js";
import { walletHostProviders } from "./wallet-issuers.js";

function title(id: string): string {
  return (
    NAMES.get(id) ??
    id.replace(
      /(^|-)([a-z])/g,
      (_, separator: string, letter: string) =>
        `${separator ? " " : ""}${letter.toUpperCase()}`,
    )
  );
}

function categoryOf(id: string): ProviderCategory {
  for (const [category, providerIds] of CATEGORY) {
    if (providerIds.includes(id)) return category;
  }
  return "developer";
}

function preview(
  id: string,
  docsUrl: string,
  authKind: Provider["authKind"],
  category = categoryOf(id),
): Provider {
  return {
    id,
    displayName: title(id),
    category,
    docsUrl,
    authKind,
    supportsRefresh: false,
    configured: false,
    autoConfigurable:
      id === "plain" || id === "sealed-local" || id === "webcrypto",
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "none", authorities: [], pathPrefixes: [] },
    operations: [
      authKind === "configuration" ? "secret.configure" : "model.invoke",
    ],
    configurationFields: FIELDS.get(id) ?? [],
  };
}

export const bundledProviders: Provider[] = [
  (() => {
    const provider = preview(
      "webcrypto",
      "https://developer.mozilla.org/docs/Web/API/Web_Crypto_API",
      "configuration",
      "encryption",
    );
    provider.displayName = "WebCrypto (this device)";
    provider.autoConfigurable = true;
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap", "aead.seal"];
    return provider;
  })(),
  (() => {
    const provider = preview(
      "yubikey",
      "https://github.com/str4d/age-plugin-yubikey",
      "configuration",
      "encryption",
    );
    provider.displayName = "YubiKey";
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap"];
    return provider;
  })(),
  (() => {
    const provider = preview(
      "aws-kms",
      "https://docs.aws.amazon.com/kms/latest/developerguide/",
      "configuration",
      "encryption",
    );
    provider.displayName = "AWS KMS";
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap"];
    return provider;
  })(),
  (() => {
    const provider = preview(
      "azure-key-vault-keys",
      "https://learn.microsoft.com/azure/key-vault/keys/",
      "configuration",
      "encryption",
    );
    provider.displayName = "Azure Key Vault Keys";
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap"];
    return provider;
  })(),
  (() => {
    const provider = preview(
      "gcp-kms",
      "https://cloud.google.com/kms/docs",
      "configuration",
      "encryption",
    );
    provider.displayName = "Google Cloud KMS";
    provider.configured = true;
    provider.operations = ["key.wrap", "key.unwrap"];
    return provider;
  })(),
  // fido2 is not a connector — WebAuthn PRF passkeys live under Unlock methods /
  // Vault key protection. Keep the fnox parity list intact; omit the row here.
  ...parity.providers
    .filter(
      (id) =>
        id !== "fido2" &&
        id !== "yubikey" &&
        id !== "aws-kms" &&
        id !== "azure-key-vault-keys" &&
        id !== "gcp-kms",
    )
    .map((id) =>
      preview(id, `https://fnox.jdx.dev/providers/${id}.html`, "configuration"),
    ),
  ...HOST.map((entry) => {
    const provider = preview(entry.id, entry.docs, entry.auth);
    provider.supportsRefresh = entry.refresh;
    provider.operations = [...entry.operations];
    provider.egress = {
      scheme: "https",
      authorities: [...entry.authorities],
      pathPrefixes: [],
    };
    return provider;
  }),
  ...LLM.map(([id, docs, auth]) => preview(id, docs, auth, "agent_harnesses")),
  ...IDENTITY.map(([id, docs, auth]) => {
    const provider = preview(id, docs, auth, "identity");
    provider.operations =
      id === "workos"
        ? ["user.read", "organization.read", "directory.read"]
        : ["identity.configure"];
    if (id === "workos") {
      provider.egress = {
        scheme: "https",
        authorities: ["api.workos.com"],
        pathPrefixes: [],
      };
    }
    return provider;
  }),
  ...NETWORKING.map(([id, docs, auth]) =>
    Object.assign(preview(id, docs, auth, "networking"), {
      operations: ["network.configure"],
    }),
  ),
  ...WALLET.map(([id, docs, auth]) =>
    Object.assign(preview(id, docs, auth, "wallet"), {
      operations: ["wallet.configure"],
    }),
  ),
  ...walletHostProviders((id, docs, auth) => preview(id, docs, auth, "wallet")),
];

function validProvider(value: BoundaryValue): value is Provider {
  if (!isJsonObject(value)) return false;
  const item = value;
  return (
    isString(item.id) &&
    isString(item.displayName) &&
    isString(item.category) &&
    isString(item.docsUrl) &&
    isString(item.authKind) &&
    isBoolean(item.configured) &&
    isBoolean(item.autoConfigurable) &&
    Array.isArray(item.missingConfig) &&
    Array.isArray(item.scopes) &&
    Array.isArray(item.operations)
  );
}

export function decodeEmbeddedProviders(value: string): Provider[] | null {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isJsonObject(parsed) ||
    parsed.revision !== BUNDLED_REVISION ||
    !Array.isArray(parsed.providers)
  ) {
    return null;
  }
  const providers = parsed.providers;
  return providers.length > 0 && providers.every(validProvider)
    ? providers
    : null;
}

async function readEmbeddedProvidersDefault(): Promise<Provider[]> {
  return getBundledProviders();
}

async function writeEmbeddedProvidersDefault(
  _providers: Provider[],
): Promise<void> {}

export const embeddedCatalogSeams = {
  bundledProviders,
  readEmbeddedProviders: readEmbeddedProvidersDefault,
  writeEmbeddedProviders: writeEmbeddedProvidersDefault,
};

export function getBundledProviders(): Provider[] {
  return [bundledGitProvider(), ...embeddedCatalogSeams.bundledProviders];
}

export async function readEmbeddedProviders(): Promise<Provider[]> {
  return embeddedCatalogSeams.readEmbeddedProviders();
}

export async function writeEmbeddedProviders(
  providers: Provider[],
): Promise<void> {
  return embeddedCatalogSeams.writeEmbeddedProviders(providers);
}
