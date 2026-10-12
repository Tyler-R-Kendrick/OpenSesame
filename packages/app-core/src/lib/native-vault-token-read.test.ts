import { expect, it } from "vitest";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { configureNativeLocalInstance } from "./native-local-instance.js";
import { readNativeVaultToken } from "./native-vault-token-read.js";

installNativeApiTests();
const token = "hvs.private-kv-provider-token";
const draft = {
  providerId: "vault" as const,
  displayName: "My Vault",
  icon: "",
  endpoint: "https://vault.example.org",
  namespace: "acme/team",
  apiKey: token,
};
const lookup = {
  data: {
    display_name: "Engineer",
    entity_id: "user-1",
    policies: ["default", "kv-read"],
    ttl: 3600,
    renewable: true,
  },
};
const secret = {
  data: {
    data: { password: "private-kv-value", nested: { enabled: true } },
    metadata: { version: 7 },
  },
};
const read = { mount: "secret", path: "app/config" };
const classification = {
  publicParameters: ["endpoint", "namespace"],
  privateCredentials: ["api_key"],
};

it.each(["vault", "openbao"] as const)(
  "reads actual KVv2 data from a verified %s token's instance and namespace",
  async (providerId) => {
    const answers = nativeAnswers(
      { body: lookup },
      { body: lookup },
      { body: secret },
    );
    const saved = await configureNativeLocalInstance(
      { ...draft, providerId },
      answers.transport,
    );
    expect(
      await readNativeVaultToken(
        saved.connectionId,
        { ...read, version: 3 },
        answers.transport,
      ),
    ).toEqual({ data: secret.data.data, metadata: { version: 7 } });
    const [url, init] = answers.fetch.mock.calls[2] ?? [];
    expect(String(url)).toBe(
      `${draft.endpoint}/v1/secret/data/app/config?version=3`,
    );
    expect(new Headers(init?.headers).get("X-Vault-Token")).toBe(token);
    expect(new Headers(init?.headers).get("X-Vault-Namespace")).toBe(
      draft.namespace,
    );
    expect(init).toMatchObject({
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
    });
    expect(readNativeConnector(saved.connectionId)?.revision).toBe(
      saved.revision,
    );
    expect(
      JSON.stringify(readNativeConnector(saved.connectionId)),
    ).not.toContain("private-kv-value");
  },
);
it("preserves valid token proof after a KV policy denial verified by lookup-self", async () => {
  const answers = nativeAnswers(
    { body: lookup },
    { body: lookup },
    { body: { errors: ["permission denied"] }, status: 403 },
  );
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  await expect(
    readNativeVaultToken(saved.connectionId, read, answers.transport),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(readNativeConnector(saved.connectionId)?.revision).toBe(
    saved.revision,
  );
});
it("invalidates a rejected lookup token before exposing any secret path to the provider", async () => {
  const answers = nativeAnswers(
    { body: lookup },
    { body: { errors: ["permission denied"] }, status: 403 },
  );
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  await expect(
    readNativeVaultToken(saved.connectionId, read, answers.transport),
  ).rejects.toThrow("permissions");
  expect(answers.fetch).toHaveBeenCalledTimes(2);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
});
it("invalidates the bound token when KV itself proves authorization has expired", async () => {
  const answers = nativeAnswers(
    { body: lookup },
    { body: lookup },
    { body: { errors: ["expired token"] }, status: 401 },
  );
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  await expect(
    readNativeVaultToken(saved.connectionId, read, answers.transport),
  ).rejects.toThrow("authorization");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
});
it("refuses unverified saved credentials before provider egress", async () => {
  const answers = nativeAnswers({ body: lookup });
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  await updateNativeConnector(
    saved.connectionId,
    { revision: saved.revision, fingerprint: saved.fingerprint },
    classification,
    (current) => {
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      return current;
    },
  );
  await expect(
    readNativeVaultToken(saved.connectionId, read, answers.transport),
  ).rejects.toThrow("Verify");
  expect(answers.fetch).toHaveBeenCalledTimes(1);
});
it("does not request KV after a concurrent connector change during token verification", async () => {
  const answers = nativeAnswers({ body: lookup });
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  answers.fetch.mockImplementationOnce(async () => {
    await updateNativeConnector(
      saved.connectionId,
      { revision: saved.revision, fingerprint: saved.fingerprint },
      classification,
      (current) => {
        current.configuration.displayName = "Updated Vault";
        return current;
      },
    );
    return Response.json(lookup);
  });
  await expect(
    readNativeVaultToken(saved.connectionId, read, answers.transport),
  ).rejects.toThrow("changed");
  expect(answers.fetch).toHaveBeenCalledTimes(2);
});
it("rejects path traversal before either lookup or KV egress", async () => {
  const answers = nativeAnswers({ body: lookup });
  const saved = await configureNativeLocalInstance(draft, answers.transport);
  await expect(
    readNativeVaultToken(
      saved.connectionId,
      { ...read, path: "app/../other" },
      answers.transport,
    ),
  ).rejects.toThrow("traversal");
  expect(answers.fetch).toHaveBeenCalledTimes(1);
});
