import { afterEach, expect, it } from "vitest";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { readSnowflakeDatabases } from "./native-snowflake-http.js";
import { snowflakeKeyFlows } from "./native-snowflake.js";
import {
  expectedSnowflakeDatabases as expected,
  invalidSnowflakeAccounts,
  malformedSnowflakeReplies,
  snowflakeAccount,
  snowflakeData,
  snowflakeDraft,
  snowflakeHandle,
  snowflakeOracle,
  snowflakePending,
  snowflakeToken,
} from "./native-snowflake.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function oracle(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  const o = await snowflakeOracle(mode);
  closes.push(o.close);
  return o;
}
async function saved(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  const local = await runtimeFixture();
  closes.push(() => local.close());
  const o = await oracle(mode);
  const view = await snowflakeKeyFlows.configure(
    snowflakeDraft(mode),
    o.transport,
  );
  return {
    local,
    o,
    view,
    read: () =>
      snowflakeKeyFlows.invoke(
        view.connectionId,
        "provider.databases.read",
        {},
        o.transport,
      ),
  };
}
it.each(["PROGRAMMATIC_ACCESS_TOKEN", "OAUTH"])(
  "%s proves the real fixed SQL, saves a sealed exact binding and consumes metadata",
  async (mode) => {
    const s = await saved(mode);
    expect(s.view.status).toBe("connected");
    expect(await s.read()).toEqual(expected);
    expect([...s.local.files.values()].join()).not.toContain(snowflakeToken);
    expect(
      loadNativeConnectorRecord(s.view.connectionId)?.privateState.credentials
        .token,
    ).toBe(snowflakeToken);
    expect(
      s.o.requests.every((row) => row.authorized && row.method === "POST"),
    ).toBe(true);
    expect(s.o.origins).toEqual([snowflakeAccount, snowflakeAccount]);
    expect(s.local.fetcher).not.toHaveBeenCalled();
  },
);
it("handles actual202 pending replies and all locally constructed partitions without following statusURLs", async () => {
  const o = await oracle();
  let polls = 0;
  o.reply((request, response) => {
    if (
      request.method === "POST" ||
      (!request.url?.includes("partition") && polls++ < 10)
    ) {
      response.writeHead(202);
      response.end(JSON.stringify(snowflakePending));
      return;
    }
    if (request.url?.includes("partition=1")) {
      response.end(
        JSON.stringify({
          code: "090001",
          sqlState: "00000",
          statementHandle: snowflakeHandle,
          data: [snowflakeData.data[1]],
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        ...snowflakeData,
        resultSetMetaData: {
          ...snowflakeData.resultSetMetaData,
          partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }],
        },
        data: [snowflakeData.data[0]],
      }),
    );
  });
  expect(await readSnowflakeDatabases(snowflakeDraft(), o.transport)).toEqual(
    expected,
  );
  expect(o.requests.slice(1).map((row) => row.path)).toEqual([
    ...Array.from(
      { length: 11 },
      () => `/api/v2/statements/${snowflakeHandle}`,
    ),
    `/api/v2/statements/${snowflakeHandle}?partition=1`,
  ]);
  expect(o.requests.every((row) => row.authorized)).toBe(true);
  expect(o.origins.every((origin) => origin === snowflakeAccount)).toBe(true);
});
it("bounds polling a genuinely pending statement, without issuing provider cancellation", async () => {
  const o = await oracle();
  o.reply((_request, response) => {
    response.writeHead(202);
    response.end(JSON.stringify(snowflakePending));
  });
  await expect(
    readSnowflakeDatabases(snowflakeDraft(), o.transport),
  ).rejects.toMatchObject({ code: "network" });
  expect(o.requests.length).toBeGreaterThan(8);
  expect(o.requests.length).toBeLessThanOrEqual(65);
  expect(
    o.requests
      .slice(1)
      .every(
        (row) => row.method === "GET" && row.path.endsWith(snowflakeHandle),
      ),
  ).toBe(true);
});
it.each([
  [401, "authorization"],
  [403, "permission"],
  [408, "response"],
  [422, "response"],
  [429, "rate-limit"],
  [500, "response"],
  [302, "response"],
] as const)(
  "preserves HTTP%s safely and never follows a failed or redirected response",
  async (status, code) => {
    const o = await oracle();
    o.reply((_request, response) => {
      response.writeHead(status, {
        Location: "https://untrusted.example/token",
      });
      response.end(
        JSON.stringify({
          code: "000904",
          sqlState: "42000",
          message: snowflakeToken,
        }),
      );
    });
    await expect(
      readSnowflakeDatabases(snowflakeDraft(), o.transport),
    ).rejects.toMatchObject({ code, status });
    expect(o.requests).toHaveLength(1);
  },
);
it.each(malformedSnowflakeReplies)(
  "rejects malformed/error/partial/duplicate/reflected successful payload %#",
  async ({ body }) => {
    const o = await oracle();
    o.reply((_request, response) => response.end(JSON.stringify(body)));
    await expect(
      readSnowflakeDatabases(snowflakeDraft(), o.transport),
    ).rejects.toMatchObject({ code: "response" });
    expect(o.requests).toHaveLength(1);
  },
);
it("checks unique metadata column names and types rather than assuming a name column index", async () => {
  const o = await oracle();
  for (const rowType of [
    snowflakeData.resultSetMetaData.rowType.map((col, index) =>
      index === 0 ? { name: "name", type: "text" } : col,
    ),
    snowflakeData.resultSetMetaData.rowType.map((col) =>
      col.name === "name" ? { name: "name", type: "fixed" } : col,
    ),
  ]) {
    o.reply((_request, response) =>
      response.end(
        JSON.stringify({
          ...snowflakeData,
          resultSetMetaData: { ...snowflakeData.resultSetMetaData, rowType },
        }),
      ),
    );
    await expect(
      readSnowflakeDatabases(snowflakeDraft(), o.transport),
    ).rejects.toMatchObject({ code: "response" });
  }
});
it("accepts genuine empty database metadata, not a fabricated identity item", async () => {
  const o = await oracle();
  o.reply((_request, response) =>
    response.end(
      JSON.stringify({
        ...snowflakeData,
        resultSetMetaData: {
          ...snowflakeData.resultSetMetaData,
          numRows: 0,
          partitionInfo: [],
        },
        data: [],
      }),
    ),
  );
  expect(await readSnowflakeDatabases(snowflakeDraft(), o.transport)).toEqual({
    label: "Showing 0 databases from first page",
    items: [],
  });
});
it("refuses hostile pending handles and changes to the original issued statement handle", async () => {
  const o = await oracle();
  o.reply((_request, response) => {
    response.writeHead(202);
    response.end(
      JSON.stringify({
        ...snowflakePending,
        statementHandle: "https://untrusted.example",
      }),
    );
  });
  await expect(
    readSnowflakeDatabases(snowflakeDraft(), o.transport),
  ).rejects.toMatchObject({ code: "response" });
  expect(o.requests).toHaveLength(1);
  o.reply((request, response) => {
    response.writeHead(202);
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? snowflakePending
          : {
              ...snowflakePending,
              statementHandle: "019c06a4-0000-df4f-0000-00100006589f",
            },
      ),
    );
  });
  await expect(
    readSnowflakeDatabases(snowflakeDraft(), o.transport),
  ).rejects.toMatchObject({ code: "response" });
  expect(o.requests).toHaveLength(3);
});
it("bounds individual and aggregate response bytes across asynchronous polling", async () => {
  const o = await oracle();
  o.reply((_request, response) =>
    response.end(
      JSON.stringify({ ...snowflakeData, message: "x".repeat(262145) }),
    ),
  );
  await expect(
    readSnowflakeDatabases(snowflakeDraft(), o.transport),
  ).rejects.toMatchObject({ code: "response" });
  o.reply((_request, response) => {
    response.writeHead(202);
    response.end(
      JSON.stringify({ ...snowflakePending, message: "x".repeat(190000) }),
    );
  });
  await expect(
    readSnowflakeDatabases(snowflakeDraft(), o.transport),
  ).rejects.toMatchObject({ code: "response" });
  expect(o.requests).toHaveLength(4);
});
it("retains blank tokens only for the fully identical saved account, role and authentication mode", async () => {
  const s = await saved();
  const changed = await snowflakeKeyFlows.configure(
    {
      ...snowflakeDraft(),
      connectionId: s.view.connectionId,
      revision: s.view.revision,
      displayName: "Renamed metadata",
      credentials: { token: "" },
    },
    s.o.transport,
  );
  expect(changed.status).toBe("connected");
  for (const parameters of [
    {
      ...snowflakeDraft().parameters,
      account_url: "https://other-account.snowflakecomputing.com",
    },
    { ...snowflakeDraft().parameters, role: "AUDITOR" },
    { ...snowflakeDraft().parameters, token_type: "OAUTH" },
  ])
    await expect(
      snowflakeKeyFlows.configure(
        {
          ...snowflakeDraft(),
          connectionId: changed.connectionId,
          revision: changed.revision,
          parameters,
          credentials: { token: "" },
        },
        s.o.transport,
      ),
    ).rejects.toThrow("Enter a token");
  expect(s.o.requests).toHaveLength(2);
});
it("rejects caller SQL/target overrides, wrong keys and invalid account URLs before false admission", async () => {
  const s = await saved();
  await expect(
    snowflakeKeyFlows.invoke(
      s.view.connectionId,
      "provider.databases.read",
      { statement: "DROP DATABASE" },
      s.o.transport,
    ),
  ).rejects.toThrow("supported");
  const count = s.o.requests.length;
  for (const account_url of invalidSnowflakeAccounts)
    await expect(
      snowflakeKeyFlows.configure(
        {
          ...snowflakeDraft(),
          parameters: { ...snowflakeDraft().parameters, account_url },
        },
        s.o.transport,
      ),
    ).rejects.toThrow("account URL");
  expect(s.o.requests).toHaveLength(count);
  await expect(
    snowflakeKeyFlows.configure(
      { ...snowflakeDraft(), credentials: { token: "wrong-token" } },
      s.o.transport,
    ),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("connected");
});
it.each(["POST", "GET"])(
  "physically drains a held %s on original owner withdrawal with no subsequent polls or cancel",
  async (method) => {
    const o = await oracle();
    if (method === "GET")
      o.reply((_request, response) => {
        response.writeHead(202);
        response.end(JSON.stringify(snowflakePending));
      });
    const hold = o.hold(method);
    const pending = readSnowflakeDatabases(snowflakeDraft(), o.transport);
    const rejected = expect(pending).rejects.toMatchObject({ code: "network" });
    await hold.arrived.promise;
    o.owner.abort(snowflakeToken);
    await rejected;
    await hold.closed.promise;
    expect(o.requests).toHaveLength(method === "POST" ? 1 : 2);
    expect(o.requests.some((row) => row.path.includes("cancel"))).toBe(false);
  },
);
it("a saved revision change drains its pending original operation without accepting a replacement", async () => {
  const s = await saved();
  const held = s.o.hold();
  const operation = s.read();
  const refused = expect(operation).rejects.toThrow();
  await held.arrived.promise;
  const record = loadNativeConnectorRecord(s.view.connectionId);
  if (!record) throw new Error("Missing saved connection");
  await updateNativeConnector(
    record.connectionId,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    {
      publicParameters: ["account_url", "token_type", "role"],
      privateCredentials: ["token"],
    },
    (current) => ({
      ...current,
      configuration: {
        ...current.configuration,
        displayName: "Changed original revision",
      },
    }),
  );
  await refused;
  await held.closed.promise;
  expect(s.o.requests).toHaveLength(2);
});
it("the original fifteen-second operation deadline drains a live but nonresponsive read-only statement", async () => {
  const o = await oracle();
  const hold = o.hold();
  const pending = readSnowflakeDatabases(snowflakeDraft(), o.transport);
  const rejected = expect(pending).rejects.toMatchObject({ code: "network" });
  await hold.arrived.promise;
  await rejected;
  await hold.closed.promise;
  expect(o.requests).toHaveLength(1);
});
