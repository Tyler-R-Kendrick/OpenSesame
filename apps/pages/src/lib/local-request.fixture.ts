import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import { vi } from "vitest";
import {
  consumeLocalAccessRequest,
  decideLocalAccessRequest,
} from "./local-access-requests.js";
import { configureLocalApplication } from "./local-applications.js";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "./local-directory.js";
import { enrollLocalPasskey } from "./local-passkeys.js";
import { createLocalApplicationRequest } from "./local-request-authorization.js";
import type { LocalSession } from "./local-sessions.js";
import { signInLocalIdentity } from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { unlockTomb } from "./vfs.js";

export async function consumedApplicationRequest(
  tomb: string,
  session: LocalSession,
  request: LocalAuthorizationRequest,
  principalId = session.principalId,
) {
  const pending = await createLocalApplicationRequest(tomb, session, request);
  const approved = await decideLocalAccessRequest(tomb, {
    ...pending,
    principalId,
    decision: "approve",
  });
  return consumeLocalAccessRequest(tomb, session, approved, async (row) => row);
}

export async function localRequestFixture() {
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  const tomb = `local-requests-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  const device = await authenticator();
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks: {
      request: <T>(_name: string, action: () => Promise<T>) => {
        const next = queue.then(action);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  async function change(input: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      input,
    );
  }
  for (const kind of ["person", "organization", "application"] as const)
    await change({ action: "create", kind, name: `Test ${kind}` });
  const directory = await readLocalDirectory(tomb);
  const person = directory.entries.find((row) => row.kind === "person");
  const org = directory.entries.find((row) => row.kind === "organization");
  const app = directory.entries.find((row) => row.kind === "application");
  if (!person || !org || !app) throw new Error("Missing request fixture");
  await change({
    action: "membership",
    principalId: person.id,
    organizationId: org.id,
    role: "owner",
  });
  await configureLocalApplication(tomb, 0, app.id, {
    applicationId: app.id,
    organizationId: org.id,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid"],
  });
  await enrollLocalPasskey(tomb, person.id);
  const session = await signInLocalIdentity(tomb, person.id);
  return {
    change,
    tomb,
    personId: person.id,
    applicationId: app.id,
    organizationId: org.id,
    session,
    device,
  };
}
