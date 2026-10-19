import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { nativeCiCloudResources } from "./native-api-ci-cloud-resources.js";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import { nativeApiTarget } from "./native-api-target.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";
import { deferred } from "./secret-backends/runtime.test-support.js";

installNativeApiTests();
const key = "owned/inventory~credential";
type ScopedProvider = {
  id: string;
  field: string;
  target: string;
  path: string;
  verify: BoundaryValue;
  body: BoundaryValue;
  header: string;
  auth: string;
};
const providers: ScopedProvider[] = [
  {
    id: "buildkite",
    field: "organization_slug",
    target: "owned-org",
    path: "https://api.buildkite.com/v2/organizations/owned-org/pipelines?page=1&per_page=20",
    verify: { uuid: "owned-token" },
    body: [{ id: "pipeline-owned", name: "Release" }],
    header: "authorization",
    auth: `Bearer ${key}`,
  },
  {
    id: "circleci",
    field: "project_slug",
    target: "circleci/organization-id/project-id",
    path: "https://circleci.com/api/v2/project/circleci/organization-id/project-id/pipeline",
    verify: { login: "owned-user" },
    body: {
      items: [
        {
          id: "5034460f-c7c4-4c43-9457-de07e2029e7b",
          number: 4,
          state: "created",
          project_slug: "circleci/organization-id/project-id",
        },
      ],
      next_page_token: null,
    },
    header: "circle-token",
    auth: key,
  },
];
function resource(provider: string) {
  const result = nativeCiCloudResources.find(
    (entry) => entry.providerId === provider,
  );
  if (!result) throw new Error("Missing selected inventory contract.");
  return result;
}
it.each(providers)(
  "$id preserves account verification without optional scope, but refuses inventory before a credential request",
  async (provider) => {
    const { transport, fetch } = nativeAnswers({ body: provider.verify });
    const view = await configureNativeApiConnector(
      {
        providerId: provider.id,
        displayName: "Account only",
        parameters: {},
        credentials: { api_key: key },
      },
      transport,
    );
    expect(view.status).toBe("connected");
    expect(nativeApiTarget(provider.id, {}).parameters[provider.field]).toBe(
      "",
    );
    await expect(
      resource(provider.id).read(view.connectionId, {}, transport),
    ).rejects.toThrow(/Configure/);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(providers)(
  "$id uses only its exact saved target, method and original credential placement",
  async (provider) => {
    const { transport, fetch } = nativeAnswers(
      { body: provider.verify },
      { body: provider.body },
    );
    const view = await configureNativeApiConnector(
      {
        providerId: provider.id,
        displayName: "Inventory",
        parameters: { [provider.field]: provider.target },
        credentials: { api_key: key },
      },
      transport,
    );
    const result = await resource(provider.id).read(
      view.connectionId,
      {},
      transport,
    );
    expect(result.items).toHaveLength(1);
    expect(String(fetch.mock.calls.at(-1)?.[0])).toBe(provider.path);
    const init = fetch.mock.calls.at(-1)?.[1];
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    expect(new Headers(init?.headers).get(provider.header)).toBe(provider.auth);
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
    expect(JSON.stringify(result)).not.toContain(key);
  },
);
it.each([
  "one/two",
  ".",
  "..",
  "bad?query",
  "bad#fragment",
  "bad%2Fsegment",
  "bad\\segment",
  "bad space",
])(
  "refuses a noncanonical saved Buildkite organization %s before inventory HTTP",
  async (target) => {
    const { transport, fetch } = nativeAnswers({ body: providers[0].verify });
    const view = await configureNativeApiConnector(
      {
        providerId: "buildkite",
        displayName: "Scope",
        parameters: { organization_slug: target },
        credentials: { api_key: key },
      },
      transport,
    );
    await expect(
      resource("buildkite").read(view.connectionId, {}, transport),
    ).rejects.toThrow(/canonical/);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "gh/org",
  "gh/org/project/extra",
  "gh//project",
  "gh/../project",
  "gh/org/%2fproject",
  "gh/org/repo?query",
  "gh/org/repo\\name",
])(
  "refuses a noncanonical saved CircleCI project %s before inventory HTTP",
  async (target) => {
    const { transport, fetch } = nativeAnswers({ body: providers[1].verify });
    const view = await configureNativeApiConnector(
      {
        providerId: "circleci",
        displayName: "Scope",
        parameters: { project_slug: target },
        credentials: { api_key: key },
      },
      transport,
    );
    await expect(
      resource("circleci").read(view.connectionId, {}, transport),
    ).rejects.toThrow(/Configure/);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it("encodes admitted URI segments separately while keeping the official origin and fixed path", async () => {
  const { transport, fetch } = nativeAnswers(
    { body: providers[0].verify },
    { body: providers[0].body },
  );
  const view = await configureNativeApiConnector(
    {
      providerId: "buildkite",
      displayName: "Encoded target",
      parameters: { organization_slug: "org-é" },
      credentials: { api_key: key },
    },
    transport,
  );
  await resource("buildkite").read(view.connectionId, {}, transport);
  expect(String(fetch.mock.calls.at(-1)?.[0])).toBe(
    "https://api.buildkite.com/v2/organizations/org-%C3%A9/pipelines?page=1&per_page=20",
  );
});
it("refuses caller request overrides and a different provider's saved binding without dispatch", async () => {
  const { transport, fetch } = nativeAnswers({ body: providers[0].verify });
  const view = await configureNativeApiConnector(
    {
      providerId: "buildkite",
      displayName: "Original",
      parameters: { organization_slug: "owned" },
      credentials: { api_key: key },
    },
    transport,
  );
  await expect(
    resource("circleci").read(view.connectionId, {}, transport),
  ).rejects.toThrow(/provider/);
  for (const entry of nativeCiCloudResources)
    for (const name of [
      "url",
      "body",
      "page",
      "organization_slug",
      "project_slug",
      "api_key",
    ])
      await expect(
        entry.read(view.connectionId, { [name]: "override" }, transport),
      ).rejects.toThrow(/accept/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(providers)(
  "$id cannot retain a credential for a different saved inventory target",
  async (provider) => {
    const { transport, fetch } = nativeAnswers({ body: provider.verify });
    const view = await configureNativeApiConnector(
      {
        providerId: provider.id,
        displayName: "Original",
        parameters: { [provider.field]: provider.target },
        credentials: { api_key: key },
      },
      transport,
    );
    await expect(
      configureNativeApiConnector(
        {
          connectionId: view.connectionId,
          revision: view.revision,
          providerId: provider.id,
          displayName: "Changed",
          parameters: { [provider.field]: `${provider.target}-changed` },
          credentials: {},
        },
        transport,
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(providers)(
  "$id refuses an old resource response after actual saved target replacement",
  async (provider) => {
    const { transport, fetch } = nativeAnswers(
      { body: provider.verify },
      { body: provider.verify },
    );
    const original = fetch.getMockImplementation();
    if (!original) throw new Error("Missing request fixture.");
    const arrived = deferred<void>();
    const held = deferred<Response>();
    fetch.mockImplementation((url, init) => {
      if (String(url) === provider.path) {
        arrived.resolve();
        return held.promise;
      }
      return original(url, init);
    });
    const view = await configureNativeApiConnector(
      {
        providerId: provider.id,
        displayName: "Original",
        parameters: { [provider.field]: provider.target },
        credentials: { api_key: key },
      },
      transport,
    );
    const pending = resource(provider.id).read(
      view.connectionId,
      {},
      transport,
    );
    const rejected = expect(pending).rejects.toThrow();
    await arrived.promise;
    const replacement = await configureNativeApiConnector(
      {
        connectionId: view.connectionId,
        revision: view.revision,
        providerId: provider.id,
        displayName: "Replacement",
        parameters: { [provider.field]: `${provider.target}-changed` },
        credentials: { api_key: "replacement-key" },
      },
      transport,
    );
    expect(replacement.revision).toBeGreaterThan(view.revision);
    held.resolve(
      new Response(JSON.stringify(provider.body), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);
