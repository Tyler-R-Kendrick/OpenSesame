/** Fixed read-only SQL API operation, bounded polling and metadata-mapped results. */
import { z } from "zod";
import { subscribeDeviceRows } from "./device-connector-records.js";
import {
  NativeApiError,
  type NativeApiHttpRequest,
  nativeApiHttp,
} from "./native-api-http.js";
import { projectResourceCollection } from "./native-api-resource.js";
import { safeProviderText } from "./native-api-verify.js";
import { readNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeKeyTarget } from "./native-key-types.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
export type SnowflakeTarget = NativeKeyTarget & {
  binding?: { id: string; revision: number; fingerprint: string };
};
const handle = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const count = z.number().int().nonnegative().max(20);
const failures = {
  error: z.never().optional(),
  errors: z.never().optional(),
  statementHandles: z.never().optional(),
};
const pending = z.object({
  code: z.literal("333334"),
  statementHandle: handle,
  ...failures,
});
const metadata = z.object({
  numRows: count,
  format: z.literal("jsonv2"),
  rowType: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        type: z.string().min(1).max(64),
      }),
    )
    .length(5),
  partitionInfo: z
    .array(
      z.object({
        rowCount: count,
        uncompressedSize: z.number().int().nonnegative().max(262144).optional(),
      }),
    )
    .max(20),
});
const result = z.object({
  code: z.literal("090001"),
  sqlState: z.literal("00000"),
  statementHandle: handle,
  resultSetMetaData: metadata.optional(),
  data: z.array(z.array(z.string().max(4096).nullable()).length(5)).max(20),
  ...failures,
});
const columns = ["created_on", "name", "kind", "database_name", "schema_name"];
export function snowflakeOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith(".snowflakecomputing.com") ||
    !url.hostname
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error(
      "Enter the HTTPS account URL from Snowflake Account Details.",
    );
  return url.origin;
}
function wait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new NativeApiError("network"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 250);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function checkBinding(target: SnowflakeTarget): void {
  if (!target.binding) return;
  const current = readNativeConnector(target.binding.id);
  if (
    !current ||
    current.revision !== target.binding.revision ||
    current.fingerprint !== target.binding.fingerprint
  )
    throw new Error(
      "The saved Snowflake connection changed. Reopen its configuration.",
    );
}
function validateMetadata(value: z.infer<typeof metadata>) {
  const names = value.rowType.map((column) => column.name.toLowerCase());
  if (
    new Set(names).size !== 5 ||
    columns.some((name) => !names.includes(name)) ||
    value.rowType[names.indexOf("name")]?.type.toLowerCase() !== "text" ||
    value.partitionInfo.reduce((sum, part) => sum + part.rowCount, 0) !==
      value.numRows
  )
    throw new NativeApiError("response");
  return names;
}

function statementSession(
  target: SnowflakeTarget,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const origin = snowflakeOrigin(target.parameters.account_url ?? "");
  const tokenType = z
    .enum(["PROGRAMMATIC_ACCESS_TOKEN", "OAUTH"])
    .parse(target.parameters.token_type);
  const token = target.credentials.token ?? "";
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "OpenSesame/1.0",
    "X-Snowflake-Authorization-Token-Type": tokenType,
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(transport.signal ? [transport.signal] : []),
  ]);
  const check = () => {
    transport.assertCurrent();
    signal.throwIfAborted();
    checkBinding(target);
  };
  check();
  const unsubscribe = target.binding
    ? subscribeDeviceRows(() => {
        try {
          checkBinding(target);
        } catch {
          controller.abort();
        }
      })
    : () => {};
  const deadline = setTimeout(() => controller.abort(), 15000);
  let bytes = 0;
  const request = async (path: string, body?: string) => {
    check();
    const outgoing: NativeApiHttpRequest = {
      url: origin + path,
      method: body === undefined ? "GET" : "POST",
      headers,
      signal,
    };
    if (body !== undefined) outgoing.body = body;
    const response = await nativeApiHttp(outgoing, transport);
    check();
    bytes += new TextEncoder().encode(JSON.stringify(response)).length;
    if (bytes > 524288) throw new NativeApiError("response");
    return response;
  };
  return {
    request,
    check,
    signal,
    token,
    close() {
      clearTimeout(deadline);
      unsubscribe();
      controller.abort();
    },
  };
}
type StatementSession = ReturnType<typeof statementSession>;
type SnowflakeStatementRequest = {
  statement: string;
  timeout: number;
  role?: string;
};
async function completeStatement(
  target: SnowflakeTarget,
  session: StatementSession,
) {
  const body: SnowflakeStatementRequest = {
    statement: "SHOW TERSE DATABASES LIMIT 20",
    timeout: 15,
  };
  if (target.parameters.role) body.role = target.parameters.role;
  let reply = await session.request(
    `/api/v2/statements?requestId=${crypto.randomUUID()}`,
    JSON.stringify(body),
  );
  let originalHandle: string | undefined;
  for (let poll = 0; ; poll++) {
    const progress = pending.safeParse(reply);
    if (!progress.success) break;
    if (
      poll >= 64 ||
      (originalHandle && originalHandle !== progress.data.statementHandle)
    )
      throw new NativeApiError("response");
    originalHandle = progress.data.statementHandle;
    await wait(session.signal);
    session.check();
    reply = await session.request(`/api/v2/statements/${originalHandle}`);
  }
  const first = result.parse(reply);
  if (originalHandle && first.statementHandle !== originalHandle)
    throw new NativeApiError("response");
  return first;
}
async function statementRows(
  first: z.infer<typeof result>,
  session: StatementSession,
) {
  const meta = metadata.parse(first.resultSetMetaData);
  validateMetadata(meta);
  if (first.data.length !== (meta.partitionInfo[0]?.rowCount ?? 0))
    throw new NativeApiError("response");
  const rows = [...first.data];
  for (let index = 1; index < meta.partitionInfo.length; index++) {
    const next = result.parse(
      await session.request(
        `/api/v2/statements/${first.statementHandle}?partition=${index}`,
      ),
    );
    if (
      next.statementHandle !== first.statementHandle ||
      next.data.length !== meta.partitionInfo[index]?.rowCount ||
      (next.resultSetMetaData &&
        JSON.stringify(next.resultSetMetaData) !== JSON.stringify(meta))
    )
      throw new NativeApiError("response");
    rows.push(...next.data);
  }
  if (rows.length !== meta.numRows) throw new NativeApiError("response");
  return { rows, names: validateMetadata(meta) };
}
function projectDatabases(
  rows: z.infer<typeof result>["data"],
  names: string[],
  token: string,
) {
  const items = rows.map((row) => {
    if (
      ["kind", "database_name", "schema_name"].some(
        (name) => row[names.indexOf(name)] !== null,
      )
    )
      throw new NativeApiError("response");
    const name = z.string().min(1).max(256).parse(row[names.indexOf("name")]);
    if (
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new NativeApiError("response");
    safeProviderText(name, { token, encoded: encodeURIComponent(token) });
    return { id: name, label: name };
  });
  return projectResourceCollection(items, "databases", "first-page");
}
export async function readSnowflakeDatabases(
  target: SnowflakeTarget,
  transport: NativeProviderTransport,
) {
  let session: StatementSession | undefined;
  try {
    session = statementSession(target, transport);
    const first = await completeStatement(target, session);
    const { rows, names } = await statementRows(first, session);
    const projected = projectDatabases(rows, names, session.token);
    session.check();
    return projected;
  } catch (error) {
    if (session?.signal.aborted) throw new NativeApiError("network");
    if (error instanceof NativeApiError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new NativeApiError("response");
    throw new NativeApiError("network");
  } finally {
    session?.close();
  }
}
