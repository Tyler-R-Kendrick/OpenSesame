import { once } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { createProtonPassBackend } from "./proton-pass-backend.js";
import { envelope, shareKey } from "./proton-pass-crypto.fixture.js";
import type { ProtonFolderRevision } from "./proton-pass-folders.js";
import type { ProtonItemRevision } from "./proton-pass-items.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";
export {
  envelope,
  shareKey,
  open,
  openStored,
  seeded,
  itemBytes,
} from "./proton-pass-crypto.fixture.js";

const pat = new Uint8Array(32).fill(17);
export const tokenHalf = `pst_${"P".repeat(64)}`;
export const accessToken = "private-issued-item-token";
const shareId = "PAT/share";
const prefix = `/tenant/api/pass/v1/share/${encodeURIComponent(shareId)}/`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const Create = z
  .object({
    KeyRotation: z.number().int(),
    ContentFormatVersion: z.literal(7),
    Content: z.string(),
    ItemKey: z.string(),
  })
  .strict();
const Update = z
  .object({
    KeyRotation: z.number().int(),
    LastRevision: z.number().int(),
    ContentFormatVersion: z.literal(7),
    Content: z.string(),
  })
  .strict();
const Trash = z
  .object({
    Items: z
      .array(z.object({ ItemID: z.string(), Revision: z.number().int() }))
      .length(1),
  })
  .strict();
type FixtureRequest = {
  path: string;
  method: string;
  body: string;
  headers: IncomingMessage["headers"];
};
type FixtureResponse = { created: ProtonItemRevision | null };
function state() {
  const requests: FixtureRequest[] = [];
  const folders: ProtonFolderRevision[] = [];
  const response: FixtureResponse = { created: null };
  return {
    role: "2",
    unauthorized: false,
    conflict: false,
    pageSize: 100,
    repeatCursor: false,
    hold: "",
    items: new Map<string, ProtonItemRevision>(),
    requests,
    folders,
    response,
    entered: deferred(),
    release: deferred(),
  };
}
type State = ReturnType<typeof state>;
function send(res: ServerResponse, payload: BoundaryValue, status = 200): void {
  if (res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
function authentication(
  s: State,
  path: URL,
  body: string,
  res: ServerResponse,
): boolean {
  if (path.pathname.endsWith("/personal-access-token/session")) {
    z.object({ Token: z.literal(tokenHalf) })
      .strict()
      .parse(JSON.parse(body));
    send(res, {
      Code: 1000,
      Session: {
        SessionUID: "synthetic-session",
        AccessToken: accessToken,
        RefreshToken: "private-unused-refresh",
        Scopes: ["pass"],
      },
    });
    return true;
  }
  if (s.unauthorized) {
    send(res, { Code: 10013 }, 401);
    return true;
  }
  if (path.pathname.endsWith("/share")) {
    send(res, {
      Code: 1000,
      Shares: [
        {
          ShareID: shareId,
          VaultID: "vault",
          TargetID: "vault",
          TargetType: 1,
          ShareRoleID: s.role,
          Permission: 0,
          ContentFormatVersion: 1,
          ContentKeyRotation: 1,
          Content: envelope(
            new BinaryWriter().tag(1, 2).string("Fixture vault").finish(),
            shareKey(1),
            "vaultcontent",
          ),
        },
      ],
    });
    return true;
  }
  if (path.pathname === `${prefix}key`) {
    send(res, {
      Code: 1000,
      ShareKeys: {
        Total: 2,
        Keys: [0, 1].map((rotation) => ({
          KeyRotation: rotation,
          CreateTime: 1720000000,
          Key: envelope(shareKey(rotation), pat, "sharekey"),
        })),
      },
    });
    return true;
  }
  return false;
}
function list(s: State, path: URL, res: ServerResponse): void {
  const start = Number(path.searchParams.get("Since") ?? 0);
  const items = [...s.items.values()];
  const next = start + s.pageSize;
  send(res, {
    Code: 1000,
    Items: {
      RevisionsData: items.slice(start, next),
      LastToken: next < items.length ? String(s.repeatCursor ? 1 : next) : null,
    },
  });
}
function folderList(s: State, path: URL, res: ServerResponse): void {
  const start = Number(path.searchParams.get("Since") ?? 0);
  const next = start + s.pageSize;
  send(res, {
    Code: 1000,
    Folders: {
      Folders: s.folders.slice(start, next),
      LastToken:
        next < s.folders.length ? String(s.repeatCursor ? 1 : next) : null,
    },
  });
}
function mutation(
  s: State,
  suffix: string,
  method: string,
  body: string,
  res: ServerResponse,
): void {
  if (s.conflict) {
    send(res, { Code: 2011 }, 409);
    return;
  }
  if (suffix === "item" && method === "POST") {
    const parsed = Create.parse(JSON.parse(body));
    const id = `new-${s.items.size}`;
    const item: ProtonItemRevision = {
      ItemID: id,
      Revision: 1,
      State: 1,
      FolderID: null,
      ...parsed,
    };
    s.items.set(id, item);
    send(res, { Code: 1000, Item: s.response.created ?? item });
    return;
  }
  if (suffix === "item/trash" && method === "POST") {
    const selected = Trash.parse(JSON.parse(body)).Items[0];
    const item = selected ? s.items.get(selected.ItemID) : undefined;
    if (!item || item.Revision !== selected?.Revision) {
      send(res, { Code: 2011 }, 409);
      return;
    }
    item.State = 2;
    item.Revision += 1;
    send(res, { Code: 1000 });
    return;
  }
  const item = s.items.get(decodeURIComponent(suffix.slice(5)));
  if (!item) {
    send(res, { Code: 2501 }, 404);
    return;
  }
  const update = Update.parse(JSON.parse(body));
  if (
    update.LastRevision !== item.Revision ||
    update.KeyRotation !== item.KeyRotation
  ) {
    send(res, { Code: 2011 }, 409);
    return;
  }
  item.Content = update.Content;
  item.ContentFormatVersion = update.ContentFormatVersion;
  item.Revision += 1;
  send(res, { Code: 1000 });
}
export async function protonFixture() {
  const s = state();
  const controller = new AbortController();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    s.requests.push({
      path: path.pathname + path.search,
      method,
      body,
      headers: { ...req.headers },
    });
    if (s.hold && `${method} ${path.pathname}`.endsWith(s.hold)) {
      s.entered.resolve();
      await s.release.promise;
    }
    if (authentication(s, path, body, res)) return;
    if (
      req.headers.authorization !== `Bearer ${accessToken}` ||
      req.headers["x-pm-uid"] !== "synthetic-session"
    ) {
      send(res, { Code: 10013 }, 401);
      return;
    }
    if (!path.pathname.startsWith(prefix)) {
      send(res, { Code: 2501 }, 404);
      return;
    }
    const suffix = path.pathname.slice(prefix.length);
    if (method !== "GET") {
      mutation(s, suffix, method, body, res);
      return;
    }
    if (suffix === "folder") {
      folderList(s, path, res);
      return;
    }
    if (suffix === "item") {
      list(s, path, res);
      return;
    }
    const item = s.items.get(decodeURIComponent(suffix.slice(5)));
    send(
      res,
      item ? { Code: 1000, Item: item } : { Code: 2501 },
      item ? 200 : 404,
    );
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const transport: SecretBackendTransport = {
    fetch: globalThis.fetch.bind(globalThis),
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted)
        throw new SecretBackendError("stale", "Fixture owner ended");
    },
  };
  const backend = createProtonPassBackend(transport, "web-opensesame@0.1.0");
  const config = {
    baseUrl: `http://127.0.0.1:${address.port}/tenant/api`,
    token: `${tokenHalf}::${Buffer.from(pat).toString("base64url")}`,
    vaultId: shareId,
  };
  return {
    state: s,
    controller,
    backend,
    transport,
    config,
    async close() {
      controller.abort();
      s.release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
