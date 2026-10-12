import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import {
  configureNativeGithubPersonal,
  invokeNativeGithubPersonal,
  nativeGithubPersonalCleanup,
  verifyNativeGithubPersonal,
} from "./native-github-personal.js";

installNativeApiTests();
const apiKey = "github_pat_private_test_token";
const account = { id: 12345, login: "octocat", type: "User" };
const draft = () => ({
  providerId: "github",
  displayName: "GitHub",
  parameters: {},
  credentials: { api_key: apiKey },
});
const repository = {
  id: 98765,
  full_name: "octocat/example",
  html_url: "https://github.com/octocat/example",
};

it("verifies the actual GitHub identity before sealing a usable personal token", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: account },
    { body: [repository] },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  expect(view).toMatchObject({
    status: "connected",
    identity: { id: "12345", label: "octocat", assurance: "account-verified" },
  });
  const call = answers.fetch.mock.calls[0];
  expect(String(call?.[0])).toBe("https://api.github.com/user");
  expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(
    `Bearer ${apiKey}`,
  );
  expect(call?.[1]).toMatchObject({
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  expect(JSON.stringify(view)).not.toContain(apiKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(apiKey);
  expect(
    loadNativeConnectorRecord(view.connectionId)?.privateState.credentials
      .api_key,
  ).toBe(apiKey);
  const records = await invokeNativeGithubPersonal(
    view.connectionId,
    "provider.repositories.read",
    {},
    answers.transport,
  );
  expect(records.items).toEqual([
    { id: "98765", label: "octocat/example", url: repository.html_url },
  ]);
  expect(readNativeConnector(view.connectionId)?.revision).toBe(view.revision);
});
it("refuses invalid credentials without saving a cosmetic configuration", async () => {
  const answers = nativeAnswers({
    body: { message: "Bad credentials" },
    status: 401,
  });
  await expect(
    configureNativeGithubPersonal(draft(), answers.transport),
  ).rejects.toThrow("authorization");
  expect(readDeviceRows()).toHaveLength(0);
});
it("does not invent permissions for fine-grained personal access tokens", async () => {
  const answers = nativeAnswers({ body: account });
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  expect(
    loadNativeConnectorRecord(view.connectionId)?.runtime.grants,
  ).toMatchObject([{ permissionState: "provider-managed", grantedScopes: [] }]);
});
it("preserves a valid identity when repository policy denies access", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: account },
    {
      body: { message: "Resource not accessible by personal access token" },
      status: 403,
    },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.repositories.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(view.connectionId)?.status).toBe("connected");
});
it("invalidates an expired saved token and blocks later egress until reverification", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: { message: "Bad credentials" }, status: 401 },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("authorization");
  expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.repositories.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("Verify");
  expect(answers.fetch).toHaveBeenCalledTimes(2);
});
it("refuses a switched account on a previously verified saved credential", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: { ...account, id: 99999 } },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("authorization");
  expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
});
it("returns only provider repositories with exact GitHub links", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: account },
    {
      body: [
        {
          ...repository,
          html_url: "https://github.com.evil.test/octocat/example",
        },
      ],
    },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.repositories.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("expected response");
  expect(readNativeConnector(view.connectionId)?.status).toBe("connected");
});
it("rejects arbitrary credential destinations and unsupported writes before egress", async () => {
  const answers = nativeAnswers({ body: account });
  await expect(
    configureNativeGithubPersonal(
      { ...draft(), parameters: { endpoint: "https://evil.test" } },
      answers.transport,
    ),
  ).rejects.toThrow("only");
  expect(answers.fetch).not.toHaveBeenCalled();
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.repositories.write",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("Unsupported");
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.read",
      { url: "https://evil.test" },
      answers.transport,
    ),
  ).rejects.toThrow("Unsupported");
  expect(answers.fetch).toHaveBeenCalledTimes(1);
});
it("checks the current provider without changing revision on a read", async () => {
  const answers = nativeAnswers(
    { body: account },
    { body: account },
    { body: account },
  );
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  expect(
    await invokeNativeGithubPersonal(
      view.connectionId,
      "provider.read",
      {},
      answers.transport,
    ),
  ).toEqual({ label: "octocat", items: [] });
  expect(readNativeConnector(view.connectionId)?.revision).toBe(view.revision);
  const verified = await verifyNativeGithubPersonal(
    view.connectionId,
    answers.transport,
  );
  expect(verified.status).toBe("connected");
  expect(verified.revision).toBeGreaterThan(view.revision);
});
it("forgets a shared manual token without claiming provider revocation or sending a destructive API request", async () => {
  const answers = nativeAnswers({ body: account });
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  const unregister = registerNativeProviderCleanup(
    "github",
    nativeGithubPersonalCleanup,
  );
  try {
    expect(await removeNativeConnectorWithCleanup(view.connectionId)).toBe(
      true,
    );
  } finally {
    unregister();
  }
  expect(readNativeConnector(view.connectionId)).toBeNull();
  expect(answers.fetch).toHaveBeenCalledTimes(1);
});
it("refuses malformed provider identities instead of proving a configured token", async () => {
  const answers = nativeAnswers({ body: { ...account, id: 0 } });
  await expect(
    configureNativeGithubPersonal(draft(), answers.transport),
  ).rejects.toThrow("expected response");
  expect(readDeviceRows()).toHaveLength(0);
});
it("does not publish provider data or credentials after runtime disposal", async () => {
  const answers = nativeAnswers({ body: account });
  let active = true;
  answers.transport.assertCurrent = () => {
    if (!active) throw new Error("Disposed GitHub runtime");
  };
  answers.fetch.mockImplementationOnce(async () => {
    active = false;
    return Response.json(account);
  });
  await expect(
    configureNativeGithubPersonal(draft(), answers.transport),
  ).rejects.toThrow("Could not reach");
  expect(readDeviceRows()).toHaveLength(0);
});
it("does not return stale account access after another tab updates the connector", async () => {
  const answers = nativeAnswers({ body: account });
  const view = await configureNativeGithubPersonal(draft(), answers.transport);
  const concurrent = nativeAnswers({ body: account });
  answers.fetch.mockImplementationOnce(async () => {
    await configureNativeGithubPersonal(
      {
        ...draft(),
        connectionId: view.connectionId,
        revision: view.revision,
        displayName: "Updated GitHub",
      },
      concurrent.transport,
    );
    return Response.json(account);
  });
  await expect(
    invokeNativeGithubPersonal(
      view.connectionId,
      "provider.read",
      {},
      answers.transport,
    ),
  ).rejects.toThrow("changed");
  expect(
    readNativeConnector(view.connectionId)?.configuration.displayName,
  ).toBe("Updated GitHub");
});
