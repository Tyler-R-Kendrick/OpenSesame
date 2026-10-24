import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import { secretBackendUrl } from "./http.js";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import { createOnePasswordAssetFetch } from "./onepassword-worker-assets.js";
import { createOnePasswordWorkerFetch } from "./onepassword-worker-fetch.js";
import {
  ONEPASSWORD_HTTP_MAX_PENDING,
  ONEPASSWORD_HTTP_SESSION_REQUESTS,
  type OnePasswordAssets,
  type OnePasswordCommand,
  type OnePasswordFetchMessage,
  type OnePasswordWorkerReply,
  type OnePasswordWorkerRequest,
  OnePasswordWorkerRequestSchema,
  onePasswordNetworkError,
  parseOnePasswordResult,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendFetch } from "./types.js";

export type OnePasswordNativeSdk = {
  init_client(config: string): Promise<string>;
  invoke(config: string): Promise<string>;
  release_client(clientId: string): void;
};
type EnginePorts = {
  origin: string;
  boot(
    assets: OnePasswordAssets,
    signal: AbortSignal,
    check: () => void,
  ): Promise<OnePasswordNativeSdk>;
  installFetch(fetcher: SecretBackendFetch): void;
  post(message: OnePasswordWorkerReply | OnePasswordFetchMessage): void;
  stop(): void;
};
type Initialize = Extract<OnePasswordWorkerRequest, { type: "initialize" }>;
type Invoke = Extract<OnePasswordWorkerRequest, { type: "invoke" }>;

function authExpired(error: BoundaryValue): boolean {
  const text = z.string().max(16_384).safeParse(error);
  if (!text.success) return false;
  try {
    return z
      .object({
        name: z.literal("AuthExpired"),
        message: z.string().max(16_384),
      })
      .safeParse(parseOnePasswordResult(text.data)).success;
  } catch {
    return false;
  }
}

function parameters(command: OnePasswordCommand, vaultId: string): JsonObject {
  switch (command.name) {
    case "VaultsList":
      return {};
    case "ItemsList":
      return { vault_id: vaultId, filters: [] };
    case "ItemsGet":
    case "ItemsDelete":
      return { vault_id: vaultId, item_id: command.itemId };
    case "ItemsCreate":
      if (command.params.vaultId !== vaultId) throw onePasswordNetworkError();
      return { params: command.params };
    case "ItemsPut":
      if (command.item.vaultId !== vaultId) throw onePasswordNetworkError();
      z.string().min(1).max(1024).parse(command.item.id);
      return { item: command.item };
  }
}

class OnePasswordWorkerEngine {
  private phase: "new" | "booting" | "authenticated" | "closing" | "closed" =
    "new";
  private readonly lifetime = new AbortController();
  private readonly network;
  private readonly seen = new Set<number>();
  private queued = 0;
  private queue = Promise.resolve();
  private sdk: OnePasswordNativeSdk | undefined;
  private clientId: number | undefined;
  private vaultId = "";
  constructor(private readonly ports: EnginePorts) {
    this.network = createOnePasswordWorkerFetch((message) => {
      this.check();
      this.ports.post(message);
    });
  }
  private check = () => {
    this.lifetime.signal.throwIfAborted();
    if (this.phase === "closing" || this.phase === "closed")
      throw onePasswordNetworkError();
  };
  private post(message: OnePasswordWorkerReply): void {
    if (this.phase === "closed") return;
    try {
      this.ports.post(message);
    } catch {
      this.finish();
    }
  }
  private finish(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.lifetime.abort();
    this.network.close();
    this.sdk = undefined;
    this.clientId = undefined;
    this.vaultId = "";
    try {
      this.ports.stop();
    } catch {
      return;
    }
  }
  close(code: "session" | "protocol" | "operation" = "session"): void {
    if (this.phase === "closed") return;
    this.phase = "closing";
    this.post({ type: "closed", code });
    this.finish();
  }
  private async initialize(message: Initialize): Promise<void> {
    const account = secretBackendUrl(message.settings.accountOrigin);
    if (
      account.origin !== message.settings.accountOrigin ||
      message.assets.origin !== this.ports.origin
    )
      throw onePasswordNetworkError();
    const sdk = await this.ports.boot(
      message.assets,
      this.lifetime.signal,
      this.check,
    );
    this.check();
    this.sdk = sdk;
    this.ports.installFetch(this.network.fetch);
    const value = await sdk.init_client(
      JSON.stringify({
        serviceAccountToken: message.settings.serviceAccountToken,
        programmingLanguage: "JS",
        sdkVersion: artifacts.sdk.build,
        integrationName: "OpenSesame",
        integrationVersion: "0.1.0",
        requestLibraryName: "Fetch API",
        requestLibraryVersion: "Fetch API",
        os: "browser",
        osVersion: "0.0.0",
        architecture: "wasm32",
      }),
    );
    this.check();
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw onePasswordNetworkError();
    this.clientId = Number(value);
    this.vaultId = message.settings.vaultId;
    this.phase = "authenticated";
    this.post({ type: "initialized", id: message.id });
  }
  private async invoke(message: Invoke): Promise<void> {
    if (!this.sdk || this.clientId === undefined)
      throw onePasswordNetworkError();
    const envelope = {
      invocation: {
        clientId: this.clientId,
        parameters: {
          name: message.command.name,
          parameters: parameters(message.command, this.vaultId),
        },
      },
    };
    let result: string;
    try {
      result = await this.sdk.invoke(JSON.stringify(envelope));
    } catch (error) {
      this.check();
      if (authExpired(overlapCast(error))) {
        this.close("session");
        return;
      }
      this.post({ type: "failed", id: message.id, code: "operation" });
      return;
    }
    this.check();
    if (message.command.name === "ItemsDelete") {
      this.post({ type: "result", id: message.id, result: null });
      return;
    }
    const parsed = parseOnePasswordResult(result);
    this.post({ type: "result", id: message.id, result: parsed });
  }
  private dispose(id: number): void {
    this.phase = "closing";
    this.lifetime.abort();
    this.network.close();
    const sdk = this.sdk;
    const clientId = this.clientId;
    this.clientId = undefined;
    try {
      if (clientId !== undefined) sdk?.release_client(JSON.stringify(clientId));
    } catch {
      /* Parent termination remains mandatory even when native release fails. */
    }
    this.post({ type: "disposed", id });
    this.finish();
  }
  receive(value: BoundaryValue): void {
    if (this.phase === "closed" || this.network.receive(value)) return;
    const parsed = OnePasswordWorkerRequestSchema.safeParse(value);
    if (!parsed.success) {
      this.close("protocol");
      return;
    }
    const message = parsed.data;
    if (
      this.seen.has(message.id) ||
      this.seen.size >= ONEPASSWORD_HTTP_SESSION_REQUESTS
    ) {
      this.close("protocol");
      return;
    }
    this.seen.add(message.id);
    if (message.type === "dispose") {
      this.dispose(message.id);
      return;
    }
    if (message.type === "initialize") {
      if (this.phase !== "new") {
        this.close("protocol");
        return;
      }
      this.phase = "booting";
    } else if (this.phase !== "authenticated") {
      this.close("session");
      return;
    }
    if (++this.queued > ONEPASSWORD_HTTP_MAX_PENDING) {
      this.close("session");
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        this.check();
        if (message.type === "initialize") await this.initialize(message);
        else await this.invoke(message);
        this.check();
      } catch (error) {
        this.close(authExpired(overlapCast(error)) ? "session" : "operation");
      } finally {
        this.queued--;
      }
    });
  }
}

/** A scoped engine seam for IPC/lifetime tests, never an alternate production SDK. */
export function createOnePasswordWorkerEngine(ports: EnginePorts) {
  return new OnePasswordWorkerEngine(ports);
}

async function bootSdk(
  assets: OnePasswordAssets,
  signal: AbortSignal,
  check: () => void,
  nativeFetch: SecretBackendFetch,
  install: (fetcher: SecretBackendFetch) => void,
): Promise<OnePasswordNativeSdk> {
  const assetFetch = createOnePasswordAssetFetch(
    assets,
    signal,
    check,
    nativeFetch,
  );
  install(assetFetch);
  const module: { sdk: OnePasswordNativeSdk } = await import(
    /* @vite-ignore */ assets.runtimeUrl
  );
  check();
  return module.sdk;
}

// Importing the engine in Node tests never registers a worker or downloads assets.
if ("importScripts" in globalThis) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const install = (fetcher: SecretBackendFetch) => {
    self.fetch = fetcher;
  };
  const engine = createOnePasswordWorkerEngine({
    origin: self.location.origin,
    boot: (assets, signal, check) =>
      bootSdk(assets, signal, check, nativeFetch, install),
    installFetch: install,
    post: (message) => self.postMessage(message),
    stop: () => self.close(),
  });
  self.onmessage = (event: MessageEvent<BoundaryValue>) => {
    if (event.origin !== "" && event.origin !== self.location.origin) return;
    engine.receive(event.data);
  };
}
