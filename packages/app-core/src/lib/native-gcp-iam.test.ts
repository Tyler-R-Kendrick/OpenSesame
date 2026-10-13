import { expect, it } from "vitest";
import { installNativeApiTests } from "./native-api.test-support.js";
import { readNativeConnector } from "./native-connector-store.js";
import { gcpIamKeyFlows } from "./native-gcp.js";
import {
  EMAIL,
  draft,
  installGcpKey,
  routes,
  token,
} from "./native-gcp.test-support.js";

installNativeApiTests();
installGcpKey();

it("connects IAM Credentials with only the key, proves it by a token exchange, and issues a short-lived token once", async () => {
  const fixture = routes(token);
  const saved = await gcpIamKeyFlows.configure(
    draft("gcp-iam"),
    fixture.transport,
  );
  expect(saved).toMatchObject({
    status: "connected",
    identity: { id: EMAIL, kind: "service-account" },
  });
  expect(fixture.calls).toHaveLength(1);
  const issued = routes(token, {
    match:
      /iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/target%40other-project\.iam\.gserviceaccount\.com:generateAccessToken$/,
    body: {
      accessToken: "ya29.issued-access-token-0123456789",
      expireTime: "2026-10-12T20:00:00Z",
    },
  });
  const result = await gcpIamKeyFlows.invoke(
    saved.connectionId,
    "gcp.access-token.generate",
    { service_account: "target@other-project.iam.gserviceaccount.com" },
    issued.transport,
  );
  expect(JSON.parse(String(issued.calls[1]?.init?.body))).toEqual({
    scope: ["https://www.googleapis.com/auth/cloud-platform"],
    lifetime: "3600s",
  });
  expect(result.items[0]?.secretValue).toBe(
    "ya29.issued-access-token-0123456789",
  );
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "ya29.issued",
  );
  for (const service_account of [
    "",
    "x@evil.example",
    "../x",
    "a@b.iam.gserviceaccount.com/x",
  ]) {
    const none = routes(token);
    await expect(
      gcpIamKeyFlows.invoke(
        saved.connectionId,
        "gcp.access-token.generate",
        { service_account },
        none.transport,
      ),
    ).rejects.toThrow();
    expect(none.fetch).not.toHaveBeenCalled();
  }
  // IAM Credentials takes no project.
  await expect(
    gcpIamKeyFlows.configure(
      { ...draft("gcp-iam"), parameters: { project: "my-project-123" } },
      routes(token).transport,
    ),
  ).rejects.toThrow();
});
