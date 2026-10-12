import { describe, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import { configureLinearConnector } from "./linear-connectors.js";
import { linearCredential } from "./linear-credentials.js";
import { invokeLinearConnector } from "./linear-operations.js";
import { revokeLinearConnector } from "./linear-revoke.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
} from "./linear-runtime.test-support.js";
import {
  linearGrant,
  linearPublicRecord,
  updateLinearRecord,
} from "./linear-store.js";

installLinearRuntimeTests();

describe("real provider verification before committing Linear", () => {
  it("verifies the actual workspace and saves a usable sealed API key", async () => {
    const fetcher = linearAnswers({ body: { data: linearAccount } });
    const saved = await configureLinearConnector(linearDraft(), linearOptions);
    expect(saved.status).toBe("active");
    expect(saved.accountLabel).toBe("Acme");
    expect(saved.grantedScopes).toEqual([]);
    expect(JSON.stringify(readDeviceRows())).not.toContain("private-api-key");
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "private-api-key",
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("private-api-key");
  });

  it("does not persist refused credentials or a mismatched workspace", async () => {
    linearAnswers({ body: { error: "invalid" }, status: 401 });
    await expect(
      configureLinearConnector(linearDraft(), linearOptions),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readDeviceRows()).toEqual([]);
    linearAnswers({ body: { data: linearAccount } });
    await expect(
      configureLinearConnector(linearDraft(), {
        ...linearOptions,
        workspace: "wrong-workspace",
      }),
    ).rejects.toThrow("does not match");
    expect(readDeviceRows()).toEqual([]);
    expect(readDeviceSecrets()).toEqual({});
  });

  it("never claims completion after an encrypted save fails", async () => {
    linearAnswers({ body: { data: linearAccount } });
    vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Disk refused write"),
    );
    const draft = linearDraft();
    await expect(
      configureLinearConnector(draft, linearOptions),
    ).rejects.toThrow("Disk refused write");
    expect(draft.key).toBe("private-api-key");
    expect(readDeviceRows()).toEqual([]);
  });

  it("invokes actual GraphQL and awaits the provider result", async () => {
    linearAnswers({ body: { data: linearAccount } });
    const saved = await configureLinearConnector(linearDraft(), linearOptions);
    const issue = {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Real task",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1",
    };
    const fetcher = linearAnswers({
      body: { data: { issueCreate: { success: true, issue } } },
    });
    await expect(
      invokeLinearConnector(saved.connectionId, "issue.create", {
        teamId: "team-1",
        title: "Real task",
      }),
    ).resolves.toEqual(issue);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain(
      "issueCreate(input: $input)",
    );
    linearAnswers({
      body: { errors: [{ extensions: { code: "FORBIDDEN" } }] },
    });
    await expect(
      invokeLinearConnector(saved.connectionId, "issues.list"),
    ).rejects.toMatchObject({ code: "permission" });
  });
});

describe("refresh rotation and webhook lifecycle", () => {
  async function created() {
    linearAnswers({ body: { data: linearAccount } });
    return configureLinearConnector(linearDraft(), linearOptions);
  }

  it("rotates an expired OAuth grant before using it and atomically publishes the new expiry", async () => {
    const saved = await created();
    await updateLinearRecord(saved.connectionId, async (record, runtime) =>
      linearPublicRecord(
        {
          ...record,
          secrets: {
            linear_app_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              expiresAt: Date.now() - 1,
              scopes: ["read"],
            }),
          },
        },
        {
          ...runtime,
          app: runtime.app
            ? { ...runtime.app, kind: "oauth", expiresAt: Date.now() - 1 }
            : null,
        },
      ),
    );
    const fetcher = linearAnswers({
      body: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
        token_type: "Bearer",
        scope: "read",
      },
    });
    await expect(linearCredential(saved.connectionId, "app")).resolves.toEqual({
      kind: "oauth",
      token: "new-access",
    });
    expect(linearGrant(saved.connectionId, "app")?.refreshToken).toBe(
      "new-refresh",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const form = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(form.get("refresh_token")).toBe("old-refresh");
    expect(form.has("client_secret")).toBe(false);
    await linearCredential(saved.connectionId, "app");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not use a refreshed token until the rotated grant has committed", async () => {
    const saved = await created();
    await updateLinearRecord(saved.connectionId, async (record, runtime) =>
      linearPublicRecord(
        {
          ...record,
          secrets: {
            linear_app_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "expired-access",
              refreshToken: "old-refresh",
              expiresAt: Date.now() - 1,
              scopes: ["read"],
            }),
          },
        },
        {
          ...runtime,
          app: runtime.app
            ? { ...runtime.app, kind: "oauth", expiresAt: Date.now() - 1 }
            : null,
        },
      ),
    );
    linearAnswers({
      body: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
        token_type: "Bearer",
        scope: "read",
      },
    });
    vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Rotation write failed"),
    );
    await expect(linearCredential(saved.connectionId, "app")).rejects.toThrow(
      "Rotation write failed",
    );
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "expired-access",
    );
  });

  it("removes an API-key connection locally without revoking a key the app did not create", async () => {
    const saved = await created();
    const fetcher = linearAnswers();
    await revokeLinearConnector(saved.connectionId);
    expect(deviceConnection(saved.connectionId)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
