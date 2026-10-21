/** Owned independent HTTP implementation of native Azure secret version semantics. */
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

export const AZURE_FIXTURE_TOKEN = "owned-key-vault-audience-token";
export type StoredAzureSecret = {
  id: string;
  value: string;
  contentType?: string;
  tags?: Record<string, string>;
  attributes: {
    enabled: boolean;
    recoveryLevel: string | undefined;
    created: number;
    updated: number;
    exp?: number;
    nbf?: number;
  };
  managed?: boolean;
};
const ownedPut = z.object({
  value: z.string(),
  contentType: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  attributes: z
    .object({
      enabled: z.boolean().optional(),
      nbf: z.number().int().optional(),
      exp: z.number().int().optional(),
    })
    .optional(),
});
type OwnedPut = z.infer<typeof ownedPut>;
type FixtureRequest = {
  method: string;
  path: string;
  body: OwnedPut | undefined;
};
type Fault = {
  method?: string;
  status?: number;
  body?: BoundaryValue;
  raw?: Uint8Array;
  headers?: Record<string, string>;
};
class OwnedAzureFixture {
  readonly versions = new Map<string, StoredAzureSecret[]>();
  readonly deleted = new Map<string, StoredAzureSecret[]>();
  readonly requests: FixtureRequest[] = [];
  readonly controller = new AbortController();
  origin = "";
  private fault: Fault | undefined;
  private continuation: string | undefined;
  private hold:
    | {
        arrived(): void;
        closed(): void;
        release: Promise<void>;
        bodyStatus?: number;
      }
    | undefined;
  private serial = 0;
  bundle(name: string, value: string): StoredAzureSecret {
    this.serial++;
    return {
      id: `${this.origin}/secrets/${name}/${this.serial.toString(16).padStart(32, "0")}`,
      value,
      attributes: {
        enabled: true,
        created: 1700000000,
        updated: 1700000000 + this.serial,
        recoveryLevel: "Recoverable+Purgeable",
      },
    };
  }
  reply(response: ServerResponse, status: number, body: BoundaryValue) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
  async bodyOf(request: IncomingMessage): Promise<OwnedPut | undefined> {
    if (request.method !== "PUT") return undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024)
        throw new Error("Owned Azure request body bound exceeded");
      chunks.push(chunk);
    }
    return ownedPut.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  list(url: URL) {
    const sorted = [...this.versions.keys()].sort();
    const offset = Number(url.searchParams.get("$skiptoken") ?? "0");
    const names = sorted.slice(offset, offset + 1);
    const value = names.map((name) => {
      const latest = this.versions.get(name)?.at(-1);
      return {
        id: `${this.origin}/secrets/${name}`,
        attributes: latest?.attributes,
        contentType: latest?.contentType,
        tags: latest?.tags,
      };
    });
    const nextLink =
      this.continuation ??
      (sorted.length > offset + 1
        ? `${this.origin}/secrets?api-version=2025-07-01&maxresults=1&$skiptoken=${offset + 1}`
        : undefined);
    return { value, nextLink };
  }
  execute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: OwnedPut | undefined,
  ) {
    if (url.pathname === "/secrets" && request.method === "GET")
      return this.reply(response, 200, this.list(url));
    const ref = /^\/secrets\/([a-zA-Z0-9-]+)(?:\/([a-f0-9]{32}))?$/.exec(
      url.pathname,
    );
    if (!ref)
      return this.reply(response, 404, { error: { code: "RouteNotFound" } });
    const name = (ref[1] ?? "").toLowerCase();
    const existing = this.versions.get(name);
    const selected = ref[2]
      ? existing?.find((row) => row.id.endsWith(`/${ref[2]}`))
      : existing?.at(-1);
    if (request.method === "GET")
      return this.reply(
        response,
        selected ? 200 : 404,
        selected ?? { error: { code: "SecretNotFound" } },
      );
    if (ref[2])
      return this.reply(response, 405, { error: { code: "VersionImmutable" } });
    if (request.method === "PUT") return this.write(response, name, body);
    if (request.method === "DELETE")
      return this.remove(response, name, selected, existing);
    return this.reply(response, 404, { error: { code: "SecretNotFound" } });
  }
  remove(
    response: ServerResponse,
    name: string,
    selected: StoredAzureSecret | undefined,
    existing: StoredAzureSecret[] | undefined,
  ) {
    if (selected && existing) {
      this.deleted.set(name, existing);
      this.versions.delete(name);
      return this.reply(response, 200, {
        ...selected,
        recoveryId: `${this.origin}/deletedsecrets/${name}`,
        deletedDate: 1700000999,
        scheduledPurgeDate: 1707776999,
      });
    }
    return this.reply(response, 404, { error: { code: "SecretNotFound" } });
  }
  write(response: ServerResponse, name: string, body: OwnedPut | undefined) {
    if (!body || Buffer.byteLength(body.value) > 25 * 1024)
      return this.reply(response, 400, { error: { code: "BadParameter" } });
    if (this.deleted.has(name))
      return this.reply(response, 409, {
        error: { code: "ObjectIsDeletedButRecoverable" },
      });
    const saved = this.bundle(name, body.value);
    if (body.contentType !== undefined) saved.contentType = body.contentType;
    if (body.tags) saved.tags = body.tags;
    if (body.attributes) Object.assign(saved.attributes, body.attributes);
    this.versions.set(name, [...(this.versions.get(name) ?? []), saved]);
    return this.reply(response, 200, saved);
  }
  async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", this.origin);
    if (request.headers.authorization !== `Bearer ${AZURE_FIXTURE_TOKEN}`)
      return this.reply(response, 401, {
        error: {
          code: "Unauthorized",
          message: "Never expose provider body or Bearer",
        },
      });
    if (url.searchParams.get("api-version") !== "2025-07-01")
      return this.reply(response, 400, {
        error: { code: "InvalidApiVersionParameter" },
      });
    const body = await this.bodyOf(request);
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname + url.search,
      body,
    });
    if (this.hold) {
      const held = this.hold;
      this.hold = undefined;
      response.once("close", held.closed);
      if (held.bodyStatus !== undefined) {
        response.writeHead(held.bodyStatus, {
          "Content-Type": "application/json",
        });
        response.write('{"value":');
      }
      held.arrived();
      await held.release;
      if (response.destroyed) return;
      if (held.bodyStatus !== undefined) {
        response.end("[]}");
        return;
      }
    }
    if (
      this.fault &&
      (!this.fault.method || this.fault.method === request.method)
    ) {
      const held = this.fault;
      this.fault = undefined;
      if (held.raw) {
        response.writeHead(held.status ?? 200, {
          "Content-Type": "application/json",
          ...held.headers,
        });
        response.end(held.raw);
        return;
      }
      return this.reply(response, held.status ?? 200, held.body);
    }
    this.execute(request, response, url, body);
  }
  readonly errors: string[] = [];
  readonly server;
  constructor(private readonly tls?: { key: Buffer; cert: Buffer }) {
    const handle = (request: IncomingMessage, response: ServerResponse) => {
      void this.handle(request, response).catch((error: Error) => {
        this.errors.push(String(error));
        if (!response.destroyed)
          this.reply(response, 500, { error: { code: "OwnedFixtureFailure" } });
      });
    };
    this.server = tls ? createTlsServer(tls, handle) : createServer(handle);
  }
  readonly transport: SecretBackendTransport = {
    signal: this.controller.signal,
    assertCurrent: () => {
      if (this.controller.signal.aborted)
        throw new SecretBackendError("stale", "Owned Azure lease ended");
    },
    fetch: globalThis.fetch,
  };
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(this.server.address());
    this.origin = `${this.tls ? "https" : "http"}://127.0.0.1:${address.port}`;
  }
  seed(name: string, value: string) {
    const saved = this.bundle(name, value);
    this.versions.set(name, [...(this.versions.get(name) ?? []), saved]);
    return saved;
  }
  faultNext(value: Fault) {
    this.fault = value;
  }
  nextLink(value: string) {
    this.continuation = value;
  }
  holdNext(bodyStatus?: number) {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    let close: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hold = {
      arrived: arrive,
      closed: close,
      release: released,
      bodyStatus,
    };
    return { arrived, release, closed };
  }
  async close() {
    this.controller.abort();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
export async function azureHttpFixture(tls?: { key: Buffer; cert: Buffer }) {
  const fixture = new OwnedAzureFixture(tls);
  await fixture.start();
  return fixture;
}
