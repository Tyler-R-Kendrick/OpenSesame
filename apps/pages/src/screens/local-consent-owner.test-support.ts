import { webcrypto } from "node:crypto";
import { browserPorts } from "@opensesame/app-core/browser/host.js";
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { composeHost, configureHost } from "@opensesame/app-core/host.js";
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { configureLocalApplication } from "@opensesame/app-core/lib/local-applications.js";
import {
  authenticator,
  origin,
  rpID,
} from "@opensesame/app-core/lib/local-authenticator.fixture.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { bindLocalIamLockResets } from "@opensesame/app-core/lib/local-iam-lock-resets.js";
import { enrollLocalPasskey } from "@opensesame/app-core/lib/local-passkeys.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import { cleanup } from "@testing-library/react";
import { vi } from "vitest";

async function browserOwner() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const device = await authenticator();
  vi.stubGlobal("navigator", { ...navigator, credentials: device });
  const location = {
    origin,
    hostname: rpID,
    host: rpID,
    protocol: "https:",
    href: `${origin}/OpenSesame/identity/siop`,
    pathname: "/OpenSesame/identity/siop",
    search: "",
    hash: "",
    assign: vi.fn<(url: string | URL) => void>(),
    replace: vi.fn<(url: string | URL) => void>(),
    reload: vi.fn(),
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("isSecureContext", true);
  const browser = browserPorts();
  if (!browser.page) throw new Error("Missing genuine browser page adapter");
  configureHost(
    composeHost(browser, {
      env: { BASE_URL: "/OpenSesame/", DEV: false },
      page: {
        ...browser.page,
        location,
        opener: window,
        isSecureContext: true,
      },
    }),
  );
  const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const unbind = bindLocalIamLockResets();
  const tomb = vaultStore.activeTomb();
  return { ...owner, tomb, device, location, posted, unbind };
}

async function directoryFixture(tomb: string) {
  async function change(command: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      command,
    );
  }
  async function create(
    kind: "person" | "application" | "organization" | "agent",
    name: string,
  ) {
    const directory = await change({ action: "create", kind, name });
    const entry = directory.entries.find((row) => row.name === name);
    if (!entry) throw new Error(`Missing actual fixture identity ${name}`);
    return entry.id;
  }
  const person = await create("person", "Consent owner");
  const member = await create("person", "Consent member");
  const outsider = await create("person", "Unassigned outsider");
  const organization = await create("organization", "Consent organization");
  const application = await create("application", "Registered relying party");
  await change({
    action: "membership",
    principalId: person,
    organizationId: organization,
    role: "owner",
  });
  await change({
    action: "membership",
    principalId: member,
    organizationId: organization,
    role: "member",
  });
  const redirect = "https://rp.example.test/callback";
  await configureLocalApplication(tomb, 0, application, {
    applicationId: application,
    organizationId: organization,
    redirectUris: [redirect],
    scopes: ["openid"],
  });
  await enrollLocalPasskey(tomb, person);
  const request: LocalAuthorizationRequest = {
    applicationId: application,
    redirectUri: redirect,
    scopes: ["openid"],
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256",
  };
  return {
    person,
    member,
    outsider,
    organization,
    application,
    redirect,
    request,
    change,
    create,
  };
}

export async function consentOwner() {
  const owner = await browserOwner();
  const directory = await directoryFixture(owner.tomb);
  const { redirect, request } = directory;
  const pipes: MessageChannel[] = [];
  function connect() {
    const pipe = new MessageChannel();
    pipes.push(pipe);
    window.dispatchEvent(
      Object.assign(new Event("message"), {
        source: window,
        origin: new URL(redirect).origin,
        ports: [pipe.port2],
        data: {
          type: "opensesame:local:connect",
          state: request.state,
          version: "1",
        },
      }),
    );
    return pipe.port1;
  }
  async function release() {
    cleanup();
    vaultStore.lock();
    owner.unbind();
    for (const pipe of pipes) {
      pipe.port1.close();
      pipe.port2.close();
    }
    await kvFlush();
    kvForgetAll();
    configureHost(createTestHost());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  return { ...owner, ...directory, connect, release };
}
export type ConsentOwner = Awaited<ReturnType<typeof consentOwner>>;
