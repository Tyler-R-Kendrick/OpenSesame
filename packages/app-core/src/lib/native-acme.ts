/**
 * Let's Encrypt from a browser (ADR 0198): an ACME account whose key is made in
 * this page and sealed on this device, DNS-01 orders opened on request, and the
 * certificate chain downloaded once the person has published the records. The
 * certificate's own private key is generated here, shown once and never kept.
 * Verification is the CA finding or creating the account for the saved key.
 */
import { canonicalize } from "@opensesame/os-domain";
import { canonicalProviderId } from "./connector-catalog.js";
import { isCertificateName } from "./native-acme-csr.js";
import {
  MAX_ACME_NAMES,
  beginAcmeOrder,
  finishAcmeOrder,
  isAcmeOrderUrl,
  registerAcmeAccount,
} from "./native-acme-order.js";
import {
  type AcmeEnvironment,
  acmeAccountKey,
  acmeOwn,
  generateAcmeAccountJwk,
  openAcme,
} from "./native-acme-protocol.js";
import { nativeAcmeUi } from "./native-acme-ui.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type { NativeKeyTarget } from "./native-key-types.js";

const KEY = "account_key";
const ENVIRONMENTS: readonly AcmeEnvironment[] = ["production", "staging"];

export function isNativeAcmeProvider(providerId: string): boolean {
  return canonicalProviderId(providerId) === "letsencrypt";
}

function environmentOf(target: NativeKeyTarget): AcmeEnvironment {
  const value = target.parameters.environment;
  const found = ENVIRONMENTS.find((entry) => entry === value);
  if (!found) throw new Error("Choose production or staging");
  return found;
}

/** The names a person typed, lower-cased and de-duplicated, each one a name a certificate can carry. */
export function parseAcmeNames(text: string): string[] {
  const names = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter(Boolean),
    ),
  ];
  if (!names.length || names.length > MAX_ACME_NAMES)
    throw new Error(`Enter between 1 and ${MAX_ACME_NAMES} DNS names`);
  const bad = names.find((name) => !isCertificateName(name));
  if (bad)
    throw new Error("Enter DNS names such as example.com or *.example.com");
  return names;
}

async function digest(environment: string) {
  const bytes = new TextEncoder().encode(
    canonicalize({
      contract: "acme:rfc8555:dns-01:v1",
      parameters: { environment },
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The environment and the agreement, the only two things the form may carry. */
function acmeChoices(input: NativeApiConfigureInput): AcmeEnvironment {
  if (
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.credentials).length ||
    Object.keys(input.parameters).some(
      (key) => !["environment", "accept_terms"].includes(key),
    )
  )
    throw new Error("Choose an environment and agree to the terms");
  const environment = ENVIRONMENTS.find(
    (entry) => entry === input.parameters.environment,
  );
  if (!environment) throw new Error("Choose production or staging");
  if (input.parameters.accept_terms !== "yes")
    throw new Error(
      "Agree to the Let's Encrypt Subscriber Agreement to create an account",
    );
  return environment;
}

async function acmeTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): Promise<NativeKeyTarget> {
  const environment = acmeChoices(input);
  // The same account for the same environment; another environment is another account.
  const same =
    saved?.configuration.parameters.environment === environment ? saved : null;
  const key =
    same?.privateState.credentials[KEY] ?? (await generateAcmeAccountJwk());
  const account = same?.configuration.parameters.account_url;
  const credentials = { [KEY]: key };
  safeProviderText(input.displayName, credentials);
  safeNativeConnectorIcon(input.icon ?? "", credentials);
  const parameters = { environment, accept_terms: "yes" };
  return {
    providerId: input.providerId,
    parameters: account ? { ...parameters, account_url: account } : parameters,
    credentials,
  };
}

/** The account the saved key stands for, found again (or created) by the CA. */
async function prove(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const environment = environmentOf(target);
  const key = await acmeAccountKey(target.credentials[KEY] ?? "");
  const account = await registerAcmeAccount(
    await openAcme(environment, key, transport),
  );
  return {
    identity: {
      id: account,
      label: `${environment === "staging" ? "Staging" : "Production"} account ${account.split("/").pop()}`,
      kind: "acme-account",
    },
    targets: [
      {
        id: environment,
        label: `Let's Encrypt ${environment}`,
        kind: "environment",
      },
    ],
    grantLabel: "Let's Encrypt account key",
    target: { key: "environment", id: environment },
    update: { parameters: { account_url: account } },
  };
}

/** A client for the saved account, ready to sign as it. */
async function session(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const environment = environmentOf(target);
  const account = target.parameters.account_url;
  if (!acmeOwn(environment)(account))
    throw new Error("Verify Let's Encrypt access before use");
  const key = await acmeAccountKey(target.credentials[KEY] ?? "");
  return { key, account, client: await openAcme(environment, key, transport) };
}

export const acmeKeyFlows = createNativeKeyFlows<NativeKeyTarget>({
  family: "Let's Encrypt",
  idPrefix: "conn_acme_",
  accepts: isNativeAcmeProvider,
  classification: {
    publicParameters: ["environment", "accept_terms", "account_url"],
    privateCredentials: [KEY],
  },
  ui: nativeAcmeUi,
  parse: acmeTarget,
  fingerprint: (target) => digest(target.parameters.environment ?? ""),
  prove,
  // Only a refused account key ends the proof; a name the CA will not certify does not.
  refused: (error) => error.code === "authorization",
  targetOf: (saved: NativeConnectorRecord): NativeKeyTarget => ({
    providerId: saved.configuration.providerId,
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
  }),
  operations: [
    {
      id: "certificate.issue",
      inputKeys: ["domains"],
      run: async (target, transport, input) => {
        const names = parseAcmeNames(input.domains ?? "");
        const { key, account, client } = await session(target, transport);
        const order = await beginAcmeOrder(client, key, account, names);
        return {
          label: order.records.length
            ? `Publish ${order.records.length} TXT record${order.records.length === 1 ? "" : "s"}, wait for them to resolve, then finish the order`
            : "Every name is already validated; finish the order",
          items: [
            {
              id: "order",
              label: "Order address (paste into Finish)",
              secretValue: order.orderUrl,
            },
            ...order.records.map((record, index) => ({
              id: `txt-${index}`,
              label: `TXT ${record.name}`,
              secretValue: record.value,
            })),
            ...order.alreadyValid.map((name) => ({
              id: `valid-${name}`,
              label: `${name} is already validated`,
            })),
          ],
        };
      },
    },
    {
      id: "certificate.finish",
      inputKeys: ["order_url"],
      run: async (target, transport, input) => {
        const environment = environmentOf(target);
        const orderUrl = (input.order_url ?? "").trim();
        if (!isAcmeOrderUrl(environment, orderUrl))
          throw new Error("Paste the order address that Issue gave you");
        const { account, client } = await session(target, transport);
        const done = await finishAcmeOrder(client, account, orderUrl);
        return {
          label: "Certificate issued; the private key is shown once",
          items: [
            {
              id: "certificate",
              label: "Certificate chain (PEM)",
              secretValue: done.chain,
            },
            {
              id: "private_key",
              label: "Private key (PEM)",
              secretValue: done.privateKey,
            },
          ],
        };
      },
    },
  ],
});
