/** Synchronous original-resource capture; crypto is loaded only inside retained leases. */
import type { VaultHeader } from "@opensesame/vault-core";
import type { RetiredCredentialInspection } from "../retired-credentials/inspection-v2.js";
import type { CapturedOwnerPrimaryRequest } from "./captured-owner-primary-request.js";
import type { PhysicalAuthenticationSnapshot } from "./physical-authentication-port.js";
import type {
  RetiredCommand,
  RetiredOperationExchange,
} from "./retired-operation-exchange.js";
import {
  captureRetiredOwnerResources,
  withRetiredOwnerReaders,
} from "./retired-owner-resources.js";
export type RetiredOwnerAuthenticationInput<T extends object> = Readonly<{
  tomb: string;
  primary: CapturedOwnerPrimaryRequest;
  exchange: RetiredOperationExchange<T>;
  original: () => void;
  failed: () => void;
  headerChanged: (header: VaultHeader) => void;
}>;

export async function runRetiredOwnerAuthentication<T extends object>(
  input: RetiredOwnerAuthenticationInput<T>,
  effect: (context: RetiredOwnerAuthenticatedData) => Promise<T>,
): Promise<T> {
  const resources = captureRetiredOwnerResources(
    input.tomb,
    () => {
      input.original();
      input.exchange.check();
    },
    input.exchange.recordDrainFailure,
  );
  return await resources.withLeases(() =>
    withRetiredOwnerReaders(resources, input.tomb, async (readers) => {
      resources.check();
      const { performRetiredOwnerAuthentication } = await import(
        "./retired-owner-authentication-work.js"
      );
      resources.check();
      return performRetiredOwnerAuthentication({
        input,
        resources,
        readers,
        effect,
      });
    }),
  );
}

export interface RetiredOwnerAuthenticatedData {
  resources: ReturnType<typeof captureRetiredOwnerResources>;
  readers: Readonly<{
    auth: Awaited<
      ReturnType<
        ReturnType<typeof captureRetiredOwnerResources>["auth"]["capture"]
      >
    >;
    device: Awaited<
      ReturnType<
        ReturnType<typeof captureRetiredOwnerResources>["device"]["capture"]
      >
    >;
    publication: Awaited<
      ReturnType<
        ReturnType<
          typeof captureRetiredOwnerResources
        >["publication"]["capture"]
      >
    >;
    identity: string;
  }>;
  snapshot: PhysicalAuthenticationSnapshot;
  header: VaultHeader;
  raw: Uint8Array;
  key: CryptoKey;
  rootCommitment: string;
  contextWire: string;
  check: () => void;
}
export async function runRetiredOwnerOperation(
  input: Parameters<
    typeof runRetiredOwnerAuthentication<RetiredCredentialInspection>
  >[0] &
    Readonly<{ command: RetiredCommand }>,
) {
  return runRetiredOwnerAuthentication(input, async (data) => {
    data.check();
    const { performRetiredOwnerManagement } = await import(
      "./retired-owner-authentication-work.js"
    );
    data.check();
    return performRetiredOwnerManagement(data, input.command);
  });
}
