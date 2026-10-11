/**
 * When a model provider's tile opens the Add sheet rather than a page of its
 * own (ADR 0188). The sheet is for a first connection a browser can make: a
 * provider that already has one is managed on its page, and one with no
 * browser road keeps the page that says so.
 */
import { isAiModelProvider } from "@opensesame/app-core/lib/ai-model-provider.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { nativeSettingsDescriptor } from "../connect/NativeConnectorPanels.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "../connect/native-connector-ui.js";

export type AiSheetTarget = {
  provider: Provider;
  descriptor: NativeConnectorDescriptor;
  method: NativeMethodDescriptor;
};

export type AiSheetInput = {
  provider: Provider | null;
  /** This provider's live connections; a revoked one does not count. */
  connections: readonly Pick<Connection, "status">[];
  connectionId: string | undefined;
  /** The route the tile led to: only the Add catalog opens a sheet. */
  pathname: string;
};

export function aiProviderSheetTarget(
  input: AiSheetInput,
): AiSheetTarget | null {
  const { provider } = input;
  if (!provider || !isAiModelProvider(provider)) return null;
  if (input.connectionId) return null;
  if (!input.pathname.startsWith("/connections/")) return null;
  if (input.connections.some((item) => item.status !== "revoked")) return null;
  const descriptor = nativeSettingsDescriptor(provider);
  const method = descriptor?.methods.find(
    (item) => item.id === "api-key" && item.available,
  );
  return descriptor && method ? { provider, descriptor, method } : null;
}
