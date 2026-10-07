/** @vitest-environment node */
import {
  type TypedItem,
  type VaultItem,
  bytesToB64,
  createCredential,
  createItem,
} from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { legacySealedAccount, plainAccount } from "../account.test-support.js";
import { SopsError } from "./errors.js";
import { planDigest, planFromRecipients } from "./plan.js";
import { SopsSession } from "./session.js";
import { newIdentity } from "./test-support.js";
import { exportVaultSecrets, importVaultSecrets } from "./vault-secrets.js";

const sessions: SopsSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.bump();
  vi.restoreAllMocks();
});
async function setup() {
  const id = await newIdentity();
  const session = new SopsSession();
  sessions.push(session);
  const plan = planFromRecipients({ format: "json", groups: [[id.recipient]] });
  const permit = session.permit({
    vaultScope: "personal",
    documentGeneration: 1,
    approvedPlanDigest: await planDigest(plan),
  });
  return { id, session, plan, permit, runner: session.runner };
}
async function encryptDocument(
  input: Awaited<ReturnType<typeof setup>>,
  value: unknown,
) {
  return input.runner.encryptNew(
    JSON.stringify(value),
    input.plan,
    input.permit,
  );
}
function importDocument(
  input: Awaited<ReturnType<typeof setup>>,
  ciphertext: string,
) {
  return importVaultSecrets({
    runner: input.runner,
    ciphertext,
    identities: [input.id.identity],
    consentToVaultCopy: false,
    permit: input.permit,
  });
}

it("round-trips supported secret kinds through real age/AES/MAC encryption", async () => {
  const input = await setup();
  const account = plainAccount("Generated account", "generated account value");
  const credential = createCredential(
    { id: crypto.randomUUID(), type: "authenticator", secret: "ONSWKZA" },
    "Generated standalone credential",
  );
  const secret = createItem("secret", "Generated secret");
  secret.value = "generated secret value";
  secret.fields = [
    {
      id: "field-generated",
      name: "Generated field",
      value: "generated hidden value",
      hidden: true,
    },
  ];
  const certificate = createItem("certificate", "Generated certificate");
  const passkey = createItem("passkey", "Generated passkey");
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = bytesToB64(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
  );
  passkey.privateKeyPkcs8B64 = pkcs8;
  certificate.privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
  const typed: TypedItem = {
    ...createItem("note", "Generated typed item"),
    kind: "typed",
    typeId: "generated-plugin",
    values: { value: "generated typed value" },
  };
  const drop = createItem("drop", "Generated drop");
  drop.bearerToken = "generated drop bearer";
  drop.claimId = "claim_generated";
  const items: VaultItem[] = [
    account,
    credential,
    secret,
    certificate,
    passkey,
    typed,
    drop,
  ];
  const ciphertext = await exportVaultSecrets({ ...input, items });
  expect(ciphertext.includes("generated secret value")).toBe(false);
  expect(ciphertext.includes(passkey.privateKeyPkcs8B64)).toBe(false);
  const dispose = vi.spyOn(input.runner, "dispose");
  const back = await importDocument(input, ciphertext);
  expect(back).toEqual({ items, thresholdRelaxed: false });
  expect(dispose).toHaveBeenCalledOnce();
});

it("includes bound credentials once and excludes an older pepper-sealed password", async () => {
  const input = await setup();
  const account = createItem("account", "Generated account");
  account.methods = [];
  const bound = createCredential(
    { id: crypto.randomUUID(), type: "authenticator", secret: "ONSWKZA" },
    "Generated bound credential",
    account.id,
  );
  const legacy = await legacySealedAccount(
    "Generated legacy account",
    "generated omitted password",
    "generated pepper",
  );
  let omitted = 0;
  const ciphertext = await exportVaultSecrets({
    ...input,
    items: [account, bound, legacy],
    onOmitted: (count) => {
      omitted = count;
    },
  });
  const back = await importDocument(input, ciphertext);
  expect(omitted).toBe(1);
  expect(back.items.filter((item) => item.kind === "credential")).toEqual([]);
  const restored = back.items.find((item) => item.id === account.id);
  expect(restored?.kind === "account" ? restored.methods : null).toEqual([
    bound.method,
  ]);
  const old = back.items.find((item) => item.id === legacy.id);
  expect(old?.kind === "account" ? old.methods : null).toEqual([]);
});

const malformed: { name: string; document: () => unknown }[] = [
  { name: "absent items", document: () => ({ other: [] }) },
  { name: "non-mapping item", document: () => ({ items: ["not an item"] }) },
  {
    name: "unsafe item id",
    document: () => ({
      items: [{ ...createItem("note"), id: "../other-owner" }],
    }),
  },
  {
    name: "unknown item field",
    document: () => ({
      items: [{ ...createItem("note"), injected: "generated" }],
    }),
  },
  {
    name: "non-text name",
    document: () => ({ items: [{ ...createItem("note"), name: 7 }] }),
  },
  {
    name: "malformed favorite",
    document: () => ({ items: [{ ...createItem("note"), favorite: "yes" }] }),
  },
  {
    name: "malformed folder",
    document: () => ({ items: [{ ...createItem("note"), folderId: 7 }] }),
  },
  {
    name: "field extra property",
    document: () => ({
      items: [
        {
          ...createItem("note"),
          fields: [
            {
              id: "field",
              name: "Field",
              value: "generated",
              hidden: true,
              injected: true,
            },
          ],
        },
      ],
    }),
  },
  {
    name: "field hidden type",
    document: () => ({
      items: [
        {
          ...createItem("note"),
          fields: [
            { id: "field", name: "Field", value: "generated", hidden: "yes" },
          ],
        },
      ],
    }),
  },
  {
    name: "secret payload type",
    document: () => ({ items: [{ ...createItem("secret"), value: 7 }] }),
  },
  {
    name: "credential account reference",
    document: () => ({
      items: [
        {
          ...createCredential(
            {
              id: crypto.randomUUID(),
              type: "authenticator",
              secret: "ONSWKZA",
            },
            "Generated",
          ),
          accountId: 7,
        },
      ],
    }),
  },
  {
    name: "credential method type",
    document: () => ({
      items: [
        {
          ...createCredential(
            {
              id: crypto.randomUUID(),
              type: "authenticator",
              secret: "ONSWKZA",
            },
            "Generated",
          ),
          method: { id: "method", type: "unknown" },
        },
      ],
    }),
  },
];
it.each(malformed)(
  "rejects an encrypted whole document with $name and disposes its real opened handle",
  async ({ document }) => {
    const input = await setup();
    const value = document();
    // A valid sibling must not be returned when another item fails validation.
    const whole =
      typeof value === "object" &&
      value !== null &&
      "items" in value &&
      Array.isArray(value.items)
        ? {
            ...value,
            items: [
              createItem("note", "Generated valid sibling"),
              ...value.items,
            ],
          }
        : value;
    const ciphertext = await encryptDocument(input, whole);
    const dispose = vi.spyOn(input.runner, "dispose");
    await expect(importDocument(input, ciphertext)).rejects.toMatchObject({
      code: "invalid_document",
    });
    expect(dispose).toHaveBeenCalledOnce();
    const handle = dispose.mock.calls[0]?.[0];
    expect(handle).toBeDefined();
    await expect(
      input.runner.saveEdited(handle ?? "", '{"items":[]}', input.permit),
    ).rejects.toBeInstanceOf(SopsError);
  },
);

it("requires explicit consent for a real multi-group document even when both identities open it", async () => {
  const input = await setup();
  const second = await newIdentity();
  const plan = planFromRecipients({
    format: "json",
    groups: [[input.id.recipient], [second.recipient]],
    shamirThreshold: 2,
  });
  const permit = input.session.permit({
    vaultScope: "personal",
    documentGeneration: 1,
    approvedPlanDigest: await planDigest(plan),
  });
  const item = createItem("secret", "Generated threshold secret");
  item.value = "generated threshold value";
  const ciphertext = await input.runner.encryptNew(
    JSON.stringify({ items: [item] }),
    plan,
    permit,
  );
  const open = vi.spyOn(input.runner, "open");
  const args = {
    runner: input.runner,
    ciphertext,
    identities: [input.id.identity, second.identity],
    permit,
  };
  await expect(
    importVaultSecrets({ ...args, consentToVaultCopy: false }),
  ).rejects.toMatchObject({ code: "unauthorized_policy" });
  expect(open).not.toHaveBeenCalled();
  expect(
    await importVaultSecrets({ ...args, consentToVaultCopy: true }),
  ).toEqual({ items: [item], thresholdRelaxed: true });
  expect(open).toHaveBeenCalledOnce();
});
