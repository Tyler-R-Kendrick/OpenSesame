import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureLocalApplication,
  inspectLocalApplicationRequest,
  readLocalApplications,
} from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { signInLocalIdentity } from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import {
  lockAllTombs,
  readFile,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

let tomb: string;
let person: string;
let org: string;
let app: string;
const redirect = "https://rp.example.test/callback";
async function change(command: LocalDirectoryChange) {
  return changeLocalDirectory(
    tomb,
    (await readLocalDirectory(tomb)).revision,
    command,
  );
}
async function create(
  kind: "person" | "application" | "organization",
  name: string,
) {
  const directory = await change({ action: "create", kind, name });
  const entry = directory.entries.find((row) => row.name === name);
  if (!entry) throw new Error("Missing fixture identity");
  return entry.id;
}
function registration(redirectUris = [redirect]) {
  return {
    applicationId: app,
    organizationId: org,
    redirectUris,
    scopes: ["openid", "profile"],
  };
}
beforeEach(async () => {
  tomb = `applications-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: await authenticator(),
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  person = await create("person", "Owner");
  org = await create("organization", "Organization");
  app = await create("application", "Application");
  await change({
    action: "membership",
    organizationId: org,
    principalId: person,
    role: "owner",
  });
  await enrollLocalPasskey(tomb, person);
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("requires registration, exact redirects, allowed scopes and a real member session", async () => {
  const session = await signInLocalIdentity(tomb, person);
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, ["openid"]),
  ).rejects.toThrow("unavailable");
  await configureLocalApplication(tomb, 0, app, registration());
  const result = await inspectLocalApplicationRequest(
    tomb,
    session,
    app,
    redirect,
    ["openid"],
  );
  expect(result).toEqual({
    applicationId: app,
    organizationId: org,
    revision: 1,
    redirectUri: redirect,
    scopes: ["openid"],
  });
  await expect(
    inspectLocalApplicationRequest(tomb, { ...session }, app, redirect, [
      "openid",
    ]),
  ).rejects.toThrow("unavailable");
  await expect(
    inspectLocalApplicationRequest(
      tomb,
      session,
      app,
      `${redirect}?next=evil`,
      ["openid"],
    ),
  ).rejects.toThrow("unavailable");
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, [
      "openid",
      "admin",
    ]),
  ).rejects.toThrow("unavailable");
  await configureLocalApplication(tomb, 1, app, null);
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, ["openid"]),
  ).rejects.toThrow("unavailable");
});

it.each([
  "https://rp.example.test/callback#token",
  "https://rp.example.test/callback#",
  "http://rp.example.test/callback",
  "javascript:alert(1)",
  "https://user@rp.example.test/callback",
  "https://*.example.test/callback",
  "https://RP.example.test/callback",
  "https://rp.example.test/a/../callback",
  "https://rp.example.test/callback\n",
  "https://rp.example.test:443/callback",
])("refuses ambiguous or unsafe redirect %s without writing", async (uri) => {
  await expect(
    configureLocalApplication(tomb, 0, app, registration([uri])),
  ).rejects.toThrow();
  expect((await readLocalApplications(tomb)).revision).toBe(0);
});

it.each([
  "http://127.0.0.1:4321/callback",
  "http://[::1]:4321/callback",
  "https://rp.example.test/callback?tenant=one",
])("accepts an exact safe callback %s", async (uri) => {
  await configureLocalApplication(tomb, 0, app, registration([uri]));
  expect(
    (await readLocalApplications(tomb)).applications[0]?.redirectUris,
  ).toEqual([uri]);
});

it("rejects scope duplication, missing openid and oversized redirect lists", async () => {
  for (const scopes of [
    [],
    ["profile"],
    ["openid", "openid"],
    ["openid", "a b"],
    ["openid", "x".repeat(65)],
  ]) {
    await expect(
      configureLocalApplication(tomb, 0, app, { ...registration(), scopes }),
    ).rejects.toThrow();
  }
  await expect(
    configureLocalApplication(
      tomb,
      0,
      app,
      registration(Array.from({ length: 17 }, (_, i) => `${redirect}/${i}`)),
    ),
  ).rejects.toThrow();
  expect((await readLocalApplications(tomb)).applications).toEqual([]);
});

it("refuses unrelated people even with valid passkeys", async () => {
  const outsider = await create("person", "Outsider");
  vi.stubGlobal("navigator", {
    credentials: await authenticator(),
    locks: navigator.locks,
  });
  await enrollLocalPasskey(tomb, outsider);
  await configureLocalApplication(tomb, 0, app, registration());
  const session = await signInLocalIdentity(tomb, outsider);
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, ["openid"]),
  ).rejects.toThrow("unavailable");
});

it("does not admit a disabled application even after signing in again", async () => {
  await configureLocalApplication(tomb, 0, app, registration());
  await change({
    action: "update",
    id: app,
    name: "Application",
    enabled: false,
  });
  const session = await signInLocalIdentity(tomb, person);
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, ["openid"]),
  ).rejects.toThrow("unavailable");
});

it("rejects stale concurrent edits and retains the first persisted configuration", async () => {
  const results = await Promise.allSettled([
    configureLocalApplication(tomb, 0, app, registration()),
    configureLocalApplication(
      tomb,
      0,
      app,
      registration([`${redirect}/other`]),
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    (await readLocalApplications(tomb)).applications[0]?.redirectUris,
  ).toEqual([redirect]);
});

it("never repairs corrupt authority data by overwriting it", async () => {
  const bytes = new TextEncoder().encode(
    '{"version":1,"revision":1,"applications":[{}]}',
  );
  await writeFile(tomb, "config/identity-applications", bytes);
  await expect(
    configureLocalApplication(tomb, 1, app, registration()),
  ).rejects.toThrow();
  expect(await readFile(tomb, "config/identity-applications")).toEqual(bytes);
});

it("does not acknowledge configuration when encrypted persistence fails", async () => {
  vi.spyOn(vfsSeams, "writeRaw").mockRejectedValue(new Error("Storage failed"));
  await expect(
    configureLocalApplication(tomb, 0, app, registration()),
  ).rejects.toThrow("Storage failed");
  expect((await readLocalApplications(tomb)).applications).toEqual([]);
});

it("legacy registrations never implicitly authorize custom scopes", async () => {
  await writeFile(
    tomb,
    "config/identity-applications",
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        revision: 1,
        applications: [{ ...registration(), revision: 1 }],
      }),
    ),
  );
  const session = await signInLocalIdentity(tomb, person);
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, ["openid"]),
  ).resolves.toMatchObject({ scopes: ["openid"] });
  await expect(
    inspectLocalApplicationRequest(tomb, session, app, redirect, [
      "openid",
      "profile",
    ]),
  ).rejects.toThrow("unavailable");
  await configureLocalApplication(tomb, 1, app, registration());
  const stored = JSON.parse(
    new TextDecoder().decode(
      await readFile(tomb, "config/identity-applications"),
    ),
  );
  expect(stored.version).toBe(2);
  expect(stored.applications[0].scopeRoles).toContainEqual({
    scope: "profile",
    roles: [],
  });
});

it("refuses a version 2 registration with missing policy instead of treating it as legacy", async () => {
  await writeFile(
    tomb,
    "config/identity-applications",
    new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        revision: 1,
        applications: [{ ...registration(), revision: 1 }],
      }),
    ),
  );
  await expect(readLocalApplications(tomb)).rejects.toThrow("unavailable");
});

it.each(["owner", "admin", "member"] as const)(
  "enforces exact scope policy for %s",
  async (role) => {
    const otherOwner = await create("person", "Retained owner");
    await change({
      action: "membership",
      organizationId: org,
      principalId: otherOwner,
      role: "owner",
    });
    await change({
      action: "membership",
      organizationId: org,
      principalId: person,
      role,
    });
    await configureLocalApplication(tomb, 0, app, {
      ...registration(),
      scopes: ["openid", "resource:read", "resource:write"],
      scopeRoles: [
        { scope: "openid", roles: ["owner", "admin", "member"] },
        { scope: "resource:read", roles: ["owner", "admin"] },
        { scope: "resource:write", roles: ["owner"] },
      ],
    });
    const session = await signInLocalIdentity(tomb, person);
    for (const scope of ["openid", "resource:read", "resource:write"]) {
      const result = inspectLocalApplicationRequest(
        tomb,
        session,
        app,
        redirect,
        [...new Set(["openid", scope])],
      );
      if (
        scope === "openid" ||
        role === "owner" ||
        (scope === "resource:read" && role === "admin")
      )
        await expect(result).resolves.toMatchObject({ applicationId: app });
      else await expect(result).rejects.toThrow("unavailable");
    }
  },
);
