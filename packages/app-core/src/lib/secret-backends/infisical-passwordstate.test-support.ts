import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { z } from "zod";

type RequestRecord = {
  method: string;
  path: string;
  authorization: string;
  body: JsonObject;
};
type FixtureMode =
  | "normal"
  | "reject"
  | "malformed"
  | "hidden"
  | "queued"
  | "redirect";
export type BackendWireFixture = Awaited<ReturnType<typeof backendWireFixture>>;

function respond(res: ServerResponse, body: BoundaryValue, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === null ? undefined : JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isJsonObject(parsed)) throw new Error("Expected JSON object");
  return parsed;
}

type StoredSecret = {
  secretKey: string;
  secretValue: string;
  secretComment: string;
};
type StoredPassword = {
  PasswordID: number;
  Title: string;
  Notes: string;
  Password: string;
  UserName: string;
  URL: string;
};

type FixtureState = { nextId: number; mode: FixtureMode };

function infisical(
  req: RequestRecord,
  res: ServerResponse,
  url: URL,
  secrets: Map<string, StoredSecret>,
  credential: string,
  mode: FixtureMode,
) {
  if (url.pathname === "/mounted/api/v1/auth/universal-auth/login") {
    if (
      req.body.clientId !== "machine-id" ||
      req.body.clientSecret !== credential
    )
      return respond(res, { error: "bad machine login" }, 401);
    return respond(res, {
      accessToken: credential,
      expiresIn: 3600,
      tokenType: "Bearer",
      accessTokenMaxTTL: 3600,
    });
  }
  if (req.authorization !== `Bearer ${credential}`)
    return respond(res, { error: "bad token" }, 401);
  const scope =
    req.method === "GET" ? Object.fromEntries(url.searchParams) : req.body;
  if (
    scope.projectId !== "project-1" ||
    scope.environment !== "dev" ||
    scope.secretPath !== "/backups"
  )
    return respond(res, { error: "wrong scope" }, 400);
  if (url.pathname === "/mounted/api/v4/secrets" && req.method === "GET")
    return respond(res, {
      secrets: [...secrets.values()].map((row) => ({
        secretKey: row.secretKey,
      })),
    });
  if (!url.pathname.startsWith("/mounted/api/v4/secrets/"))
    return respond(res, { error: "wrong route" }, 404);
  const name = decodeURIComponent(
    url.pathname.slice("/mounted/api/v4/secrets/".length),
  );
  if (req.method === "GET") {
    const row = secrets.get(name);
    return row
      ? respond(res, {
          secret: { ...row, secretValueHidden: mode === "hidden" },
        })
      : respond(res, {}, 404);
  }
  return writeInfisical(req, res, name, secrets);
}

function writeInfisical(
  req: RequestRecord,
  res: ServerResponse,
  name: string,
  secrets: Map<string, StoredSecret>,
) {
  if (req.method === "DELETE") {
    secrets.delete(name);
    return respond(res, { secret: {} });
  }
  if (req.method !== "POST" && req.method !== "PATCH")
    return respond(res, {}, 405);
  if (
    req.method === "POST" &&
    (secrets.has(name) || "newSecretName" in req.body)
  )
    return respond(res, { error: "invalid create" }, 400);
  if (req.method === "PATCH" && !secrets.has(name))
    return respond(res, {}, 404);
  if (
    !isString(req.body.secretValue) ||
    !isString(req.body.secretComment) ||
    req.body.skipMultilineEncoding !== true
  )
    return respond(res, {}, 400);
  const key =
    req.method === "PATCH" && isString(req.body.newSecretName)
      ? req.body.newSecretName
      : name;
  const row = {
    secretKey: key,
    secretValue: req.body.secretValue,
    secretComment: req.body.secretComment,
  };
  secrets.delete(name);
  secrets.set(key, row);
  return respond(res, { secret: row });
}

function passwordstate(
  req: RequestRecord,
  res: ServerResponse,
  url: URL,
  passwords: Map<number, StoredPassword>,
  credential: string,
  state: FixtureState,
) {
  if (req.authorization !== credential) return respond(res, {}, 401);
  if (
    url.pathname === "/mounted/api/passwords/77" &&
    url.searchParams.has("QueryAll")
  ) {
    if (url.searchParams.get("ExcludePassword") !== "True")
      return respond(res, {}, 400);
    return respond(
      res,
      [...passwords.values()].map(({ PasswordID, Title }) => ({
        PasswordID,
        Title,
      })),
    );
  }
  const id = Number(url.pathname.slice("/mounted/api/passwords/".length));
  if (req.method === "GET")
    return passwords.has(id)
      ? respond(res, [passwords.get(id)])
      : respond(res, {}, 404);
  if (req.method === "DELETE") {
    if (url.searchParams.get("MoveToRecycleBin") !== "True")
      return respond(res, {}, 400);
    passwords.delete(id);
    return respond(res, null, 204);
  }
  return writePasswordstate(req, res, url, passwords, state);
}

function writePasswordstate(
  req: RequestRecord,
  res: ServerResponse,
  url: URL,
  passwords: Map<number, StoredPassword>,
  state: FixtureState,
) {
  if (url.pathname !== "/mounted/api/passwords") return respond(res, {}, 404);
  if (
    req.method === "POST" &&
    (req.body.PasswordListID !== 77 || req.body.PasswordResetEnabled !== false)
  )
    return respond(res, {}, 400);
  const recordId =
    req.method === "POST" ? ++state.nextId : Number(req.body.PasswordID);
  if (req.method === "PUT" && !passwords.has(recordId))
    return respond(res, {}, 404);
  if (state.mode === "queued")
    return respond(res, [
      {
        PasswordID: recordId,
        Status: "Password Queued for Reset(s).",
        CurrentPassword: "old",
        NewPassword: req.body.Password,
      },
    ]);
  if (
    !isString(req.body.Title) ||
    !isString(req.body.Notes) ||
    !isString(req.body.Password) ||
    !isString(req.body.UserName) ||
    !isString(req.body.URL)
  )
    return respond(res, {}, 400);
  const row = {
    PasswordID: recordId,
    Title: req.body.Title,
    Notes: req.body.Notes,
    Password: req.body.Password,
    UserName: req.body.UserName,
    URL: req.body.URL,
  };
  passwords.set(recordId, row);
  return respond(res, [row]);
}

export async function backendWireFixture(
  provider: "infisical" | "passwordstate",
  credential: string,
) {
  const seen: RequestRecord[] = [];
  const secrets = new Map<string, StoredSecret>();
  const passwords = new Map<number, StoredPassword>();
  const state: FixtureState = { nextId: 100, mode: "normal" };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const record = {
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: String(
        req.headers.authorization ?? req.headers.apikey ?? "",
      ),
      body: await bodyOf(req),
    };
    seen.push(record);
    if (state.mode === "reject")
      return respond(res, { error: `secret:${credential}` }, 403);
    if (state.mode === "malformed") return respond(res, { unexpected: true });
    if (state.mode === "redirect") {
      res.writeHead(302, {
        location: "https://credentials-must-not-follow.example",
      });
      res.end();
      return;
    }
    if (provider === "infisical")
      infisical(record, res, url, secrets, credential, state.mode);
    else passwordstate(record, res, url, passwords, credential, state);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  return {
    baseUrl: `http://127.0.0.1:${address.port}/mounted`,
    seen,
    mode(value: FixtureMode) {
      state.mode = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
