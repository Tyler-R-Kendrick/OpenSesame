import "./install-browser-host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { saveDeviceConnectorConfigurationDurable } from "@opensesame/app-core/lib/device-connectors.js";
import {
  configureLocalApplication,
  readLocalApplications,
} from "@opensesame/app-core/lib/local-applications.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { enrollLocalPasskey } from "@opensesame/app-core/lib/local-passkeys.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";

const DEFAULT_REDIRECTS = ["https://rp.example.test/callback"];

/**
 * Disposable browser-context fixture. This entry is never part of the Pages
 * build. Both applications register every address in `redirectUris`: the
 * default relying party, and whichever real servers a journey names.
 */
export async function seed(redirectUris: string[] = DEFAULT_REDIRECTS) {
  await atRestReady();
  await vaultStore.create("Cedar-lantern-47-river!");
  const tomb = vaultStore.activeTomb();
  async function change(command: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      command,
    );
  }
  await change({
    action: "create",
    kind: "organization",
    name: "SIOP Organization",
  });
  await change({ action: "create", kind: "person", name: "SIOP Signer" });
  let directory = await change({
    action: "create",
    kind: "application",
    name: "SIOP primary RP",
  });
  const appOne = directory.entries.find(
    (row) => row.kind === "application" && row.name === "SIOP primary RP",
  );
  directory = await change({
    action: "create",
    kind: "application",
    name: "SIOP pairwise RP",
  });
  const appTwo = directory.entries.find(
    (row) => row.kind === "application" && row.name === "SIOP pairwise RP",
  );
  const person = directory.entries.find((row) => row.kind === "person");
  const org = directory.entries.find((row) => row.kind === "organization");
  if (!person || !org || !appOne || !appTwo)
    throw new Error("Missing SIOP fixture identity");
  await change({
    action: "membership",
    organizationId: org.id,
    principalId: person.id,
    role: "owner",
  });
  async function registerApplication(applicationId: string) {
    const { revision } = await readLocalApplications(tomb);
    await configureLocalApplication(tomb, revision, applicationId, {
      applicationId,
      organizationId: org.id,
      redirectUris,
      scopes: ["openid"],
      scopeRoles: [{ scope: "openid", roles: ["owner", "admin", "member"] }],
    });
  }
  await registerApplication(appOne.id);
  await registerApplication(appTwo.id);
  await enrollLocalPasskey(tomb, person.id);
  // A configured GitHub connection is the browser-side social choice; the
  // fixture does not hold a token, only the durable connection record the UI
  // reads after the vault is unlocked again.
  await saveDeviceConnectorConfigurationDurable(() => ({
    providerId: "github",
    displayName: "GitHub",
    scopes: [],
    fields: {},
    secrets: {},
  }));
  vaultStore.lock();
  return {
    appOneId: appOne.id,
    appTwoId: appTwo.id,
    personId: person.id,
    personName: person.name,
  };
}
