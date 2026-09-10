import type { LocalAgentPublicKey } from "@opensesame/static-auth";
import { registerLocalAgentKey } from "../../src/lib/local-agent-keys.js";
import { configureLocalApplication } from "../../src/lib/local-applications.js";
import {
  type LocalDirectoryChange,
  changeLocalDirectory,
  readLocalDirectory,
} from "../../src/lib/local-directory.js";
import { enrollLocalPasskey } from "../../src/lib/local-passkeys.js";
import { vaultStore } from "../../src/lib/vault/store.js";

/** Disposable browser-context fixture. This entry is never part of the Pages build. */
export async function seed() {
  await vaultStore.create("Cedar-lantern-47-river!");
  const tomb = vaultStore.activeTomb();
  async function change(command: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      command,
    );
  }
  await change({ action: "create", kind: "person", name: "Local test person" });
  await change({ action: "create", kind: "agent", name: "Local test agent" });
  await change({
    action: "create",
    kind: "organization",
    name: "Test organization",
  });
  const directory = await change({
    action: "create",
    kind: "application",
    name: "Test application",
  });
  const person = directory.entries.find((row) => row.kind === "person");
  const org = directory.entries.find((row) => row.kind === "organization");
  const app = directory.entries.find((row) => row.kind === "application");
  const agent = directory.entries.find((row) => row.kind === "agent");
  if (!person || !org || !app || !agent)
    throw new Error("Missing fixture identity");
  await change({
    action: "membership",
    organizationId: org.id,
    principalId: person.id,
    role: "owner",
  });
  await change({
    action: "membership",
    organizationId: org.id,
    principalId: agent.id,
    role: "member",
  });
  await configureLocalApplication(tomb, 0, app.id, {
    applicationId: app.id,
    organizationId: org.id,
    redirectUris: ["https://rp.example.test/callback"],
    scopes: ["openid", "records:read"],
    scopeRoles: [
      { scope: "openid", roles: ["owner", "admin", "member"] },
      { scope: "records:read", roles: ["owner", "member"] },
    ],
  });
  await enrollLocalPasskey(tomb, person.id);
  vaultStore.lock();
  return { app: app.id, person: person.id, agent: agent.id };
}

export async function enrollAgent(
  principalId: string,
  publicKey: LocalAgentPublicKey,
) {
  await vaultStore.unlock("Cedar-lantern-47-river!");
  await registerLocalAgentKey(vaultStore.activeTomb(), principalId, publicKey);
  vaultStore.lock();
}
