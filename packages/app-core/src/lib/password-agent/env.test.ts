import { expect, it, vi } from "vitest";
import { brokerPlan, brokerTarget, runBrokered } from "./broker.js";
import {
  parseAssignment,
  parseOsReference,
  read,
  run,
  runFile,
} from "./env.js";
import { PasswordAgent } from "./index.js";

const osRef = "os://personal/item-1/apiKey";
const opRef = "op://Automation/Item/credential";

it("parses an os:// reference into vault, item, and field segments", () => {
  expect(
    parseOsReference("os://My%20Vault/item%2Fid/method%3Ax%3Asecret"),
  ).toEqual({
    vault: "My Vault",
    item: "item/id",
    field: "method:x:secret",
  });
  expect(() => parseOsReference(opRef)).toThrow("os://");
  expect(() => parseOsReference("os://vault/item")).toThrow("os://");
  expect(() => parseOsReference("os://vault//field")).toThrow("os://");
  expect(() => parseOsReference("os://vault/item/field/extra")).toThrow(
    "os://",
  );
});

it("accepts os:// assignments alongside op:// assignments", () => {
  expect(parseAssignment(`API=${osRef}`)).toEqual({
    name: "API",
    reference: osRef,
  });
  expect(parseAssignment(`API=${opRef}`)).toEqual({
    name: "API",
    reference: opRef,
  });
});

it("reads os:// references through the local vault resolver", async () => {
  const readLocal = vi.fn(async () => "local-value");
  const port = { invoke: vi.fn(async () => "provider-value"), readLocal };
  await expect(read(port, osRef)).resolves.toBe("local-value");
  expect(readLocal).toHaveBeenCalledWith(osRef);
  await expect(read(port, opRef)).resolves.toBe("provider-value");
  await expect(read({ invoke: port.invoke }, osRef)).rejects.toThrow(
    "local vault",
  );
});

it("keeps the provider run lane for op:// assignments without mounts", async () => {
  const providerRun = vi.fn(async () => 0);
  const port = { invoke: vi.fn(async () => ""), run: providerRun };
  await expect(
    run(port, [{ name: "API", reference: opRef }], ["node"]),
  ).resolves.toBe(0);
  expect(providerRun).toHaveBeenCalledWith(["run"], ["node"], { API: opRef });
});

it("resolves os:// assignments locally and runs the child with values", async () => {
  const runWithValues = vi.fn(async () => 3);
  const readLocal = vi.fn(async () => "local-value");
  const readMany = vi.fn(async () => ["provider-value"]);
  const port = {
    invoke: vi.fn(async () => ""),
    runWithValues,
    readLocal,
    readMany,
  };
  await expect(
    run(
      port,
      [
        { name: "LOCAL", reference: osRef },
        { name: "REMOTE", reference: opRef },
      ],
      ["node", "app.js"],
    ),
  ).resolves.toBe(3);
  expect(readLocal).toHaveBeenCalledWith(osRef);
  expect(readMany).toHaveBeenCalledWith([opRef]);
  expect(runWithValues).toHaveBeenCalledWith(
    ["node", "app.js"],
    { LOCAL: "local-value", REMOTE: "provider-value" },
    [],
    ["local-value", "provider-value"],
  );
});

it("rejects startup variables for os:// assignments before resolving", async () => {
  const readLocal = vi.fn(async () => "local-value");
  const runWithValues = vi.fn(async () => 0);
  const port = { invoke: vi.fn(async () => ""), readLocal, runWithValues };
  await expect(
    run(port, [{ name: "NODE_OPTIONS", reference: osRef }], ["node"]),
  ).rejects.toThrow("startup");
  expect(readLocal).not.toHaveBeenCalled();
  expect(runWithValues).not.toHaveBeenCalled();
});

it("resolves mounted references and passes them as mount values", async () => {
  const runWithValues = vi.fn(async () => 0);
  const readLocal = vi.fn(async () => "pem-bytes");
  const port = { invoke: vi.fn(async () => ""), runWithValues, readLocal };
  await expect(
    run(port, [], ["node"], [{ name: "CERT_FILE", reference: osRef }]),
  ).resolves.toBe(0);
  expect(runWithValues).toHaveBeenCalledWith(
    ["node"],
    {},
    [{ name: "CERT_FILE", value: "pem-bytes" }],
    ["pem-bytes"],
  );
});

it("runs an env template holding os:// references with resolved values", async () => {
  const runWithValues = vi.fn(async () => 0);
  const runEnvFile = vi.fn(async () => 0);
  const readLocal = vi.fn(async () => "local-value");
  const port = {
    invoke: vi.fn(async () => ""),
    runWithValues,
    runEnvFile,
    readLocal,
  };
  await expect(
    runFile(port, ".env.tpl", ["node"], `LOCAL=${osRef}\nPLAIN=ordinary\n`),
  ).resolves.toBe(0);
  expect(runEnvFile).not.toHaveBeenCalled();
  // The literal rides along as a value but is never masked as a secret.
  expect(runWithValues).toHaveBeenCalledWith(
    ["node"],
    { LOCAL: "local-value", PLAIN: "ordinary" },
    [],
    ["local-value"],
  );
});

it("keeps the provider env-file lane when a template holds only op:// references", async () => {
  const runEnvFile = vi.fn(async () => 0);
  const port = { invoke: vi.fn(async () => ""), runEnvFile };
  await expect(
    runFile(port, ".env.tpl", ["node"], `API=${opRef}\n`),
  ).resolves.toBe(0);
  expect(runEnvFile).toHaveBeenCalledWith(`API=${opRef}\n`, ["node"]);
});

it("routes mixed references in resolveEnv to their resolvers", async () => {
  const readMany = vi.fn(async () => ["provider-value"]);
  const readLocal = vi.fn(async () => "local-value");
  const agent = new PasswordAgent({
    invoke: vi.fn(async () => ""),
    readMany,
    readLocal,
  });
  const result = await agent.resolveEnv(`REMOTE=${opRef}\nLOCAL=${osRef}\n`);
  expect(readMany).toHaveBeenCalledWith([opRef]);
  expect(readLocal).toHaveBeenCalledWith(osRef);
  expect(result.content).toContain('REMOTE="provider-value"');
  expect(result.content).toContain('LOCAL="local-value"');
  expect(result.count).toBe(2);
});

const brokerRef = "os://vault/connections%2Facme%2Fvercel/password";

it("brokers only os:// items under connections/", () => {
  expect(brokerTarget(brokerRef)).toEqual({
    providerId: "vercel",
    connectionRef: "conn://acme/vercel",
    storePath: "connections/acme/vercel",
  });
  expect(
    brokerTarget("os://vault/connections%2Facme%2Fapp%2Fgithub/credential"),
  ).toEqual({
    providerId: "github",
    connectionRef: "conn://acme/app/github",
    storePath: "connections/acme/app/github",
  });
  for (const reference of [
    opRef,
    osRef,
    "os://vault/connections%2Fvercel/password",
    "os://vault/connections%2Fa%2Fb%2Fc%2Fd/password",
    "os://vault/connections%2F..%2Fvercel/password",
  ])
    expect(() => brokerTarget(reference)).toThrow(/broker/);
});

it("requires a bounded --paths and --methods scope for every brokered name", () => {
  const assignments = [{ name: "TOKEN", reference: brokerRef }];
  expect(
    brokerPlan(
      assignments,
      ["TOKEN=/v2/user,/v9/projects"],
      ["TOKEN=GET,post"],
    ),
  ).toEqual([
    {
      name: "TOKEN",
      reference: brokerRef,
      providerId: "vercel",
      connectionRef: "conn://acme/vercel",
      methods: ["GET", "POST"],
      pathPrefixes: ["/v2/user", "/v9/projects"],
    },
  ]);
  for (const [paths, methods] of [
    [[], ["TOKEN=GET"]],
    [["TOKEN=/v2/user"], []],
    [["TOKEN=/"], ["TOKEN=GET"]],
    [["TOKEN=relative"], ["TOKEN=GET"]],
    [["TOKEN=/v2/user"], ["TOKEN=FETCH"]],
    [["OTHER=/v2/user"], ["TOKEN=GET"]],
  ] as const)
    expect(() => brokerPlan(assignments, paths, methods)).toThrow(/broker/);
  expect(() =>
    brokerPlan(
      [{ name: "TOKEN", reference: opRef }],
      ["TOKEN=/v2/user"],
      ["TOKEN=GET"],
    ),
  ).toThrow(/broker/);
});

it("fails a brokered run closed when the host has no broker capability", async () => {
  const runWithValues = vi.fn(async () => 0);
  const providerRun = vi.fn(async () => 0);
  const readLocal = vi.fn(async () => "local-value");
  const port = {
    invoke: vi.fn(async () => ""),
    run: providerRun,
    runWithValues,
    readLocal,
  };
  await expect(
    runBrokered(
      port,
      [{ name: "TOKEN", reference: brokerRef }],
      ["node"],
      ["TOKEN=/v2/user"],
      ["TOKEN=GET"],
    ),
  ).rejects.toThrow(/agent-proxy.*unavailable|unavailable.*agent-proxy/);
  // Nothing was injected instead: no lane ran and no value was resolved.
  expect(providerRun).not.toHaveBeenCalled();
  expect(runWithValues).not.toHaveBeenCalled();
  expect(readLocal).not.toHaveBeenCalled();
});

it("hands a brokered run to the host capability with the validated plan", async () => {
  const brokerHost = vi.fn(async () => 5);
  const port = { invoke: vi.fn(async () => ""), runBrokered: brokerHost };
  await expect(
    runBrokered(
      port,
      [{ name: "TOKEN", reference: brokerRef }],
      ["node", "app.js"],
      ["TOKEN=/v2/user"],
      ["TOKEN=GET"],
    ),
  ).resolves.toBe(5);
  expect(brokerHost).toHaveBeenCalledWith(
    [
      {
        name: "TOKEN",
        reference: brokerRef,
        providerId: "vercel",
        connectionRef: "conn://acme/vercel",
        methods: ["GET"],
        pathPrefixes: ["/v2/user"],
      },
    ],
    ["node", "app.js"],
  );
});
