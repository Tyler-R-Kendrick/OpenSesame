import { describe, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
} from "./linear-connectors.js";
import { linearCredential } from "./linear-credentials.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  navigate,
  pendingLinear,
  replaceAddress,
} from "./linear-runtime.test-support.js";
import {
  linearConfiguration,
  linearGrant,
  linearPublicRecord,
  updateLinearRecord,
} from "./linear-store.js";

installLinearRuntimeTests();

async function pending() {
  const connection = await configureLinearConnector(
    linearDraft("oauth"),
    linearOptions,
  );
  return {
    id: connection.connectionId,
    transaction: pendingLinear(connection.connectionId),
  };
}
const callback = (state: string, code = "one-time-code") =>
  `?linear_state=${state}&linear_code=${code}`;

describe("Linear consent actually creates provider grants", () => {
  it("re-consents and revokes the broader grant when selected app scopes are narrowed", async () => {
    const options = { ...linearOptions, appScopes: ["read", "write"] };
    const saved = await configureLinearConnector(linearDraft("oauth"), options);
    const transaction = pendingLinear(saved.connectionId);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    await finishLinearAuthorization(callback(transaction.state));
    const revocations = linearAnswers({ body: null }, { body: null });
    await configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
      saved.connectionId,
    );
    expect(revocations).toHaveBeenCalledTimes(2);
    expect(linearGrant(saved.connectionId, "app")).toBeNull();
    expect(pendingLinear(saved.connectionId).scopes).toEqual(["read"]);
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  });

  it("retains a provider-reduced rotating grant so it can be revoked and refuses further operations", async () => {
    const options = { ...linearOptions, appScopes: ["read", "write"] };
    const saved = await configureLinearConnector(linearDraft("oauth"), options);
    const transaction = pendingLinear(saved.connectionId);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    await finishLinearAuthorization(callback(transaction.state));
    await updateLinearRecord(saved.connectionId, async (record, runtime) => {
      const grant = linearGrant(saved.connectionId, "app");
      if (!grant || !runtime.app)
        throw new Error("Expected active OAuth grant");
      const expiresAt = Date.now() - 1;
      return linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            linear_app_grant: JSON.stringify({ ...grant, expiresAt }),
          },
        },
        { ...runtime, app: { ...runtime.app, expiresAt } },
      );
    });
    linearAnswers({
      body: {
        ...linearToken,
        access_token: "reduced-access",
        refresh_token: "reduced-refresh",
        scope: "read",
      },
    });
    await expect(linearCredential(saved.connectionId, "app")).rejects.toThrow(
      "permissions changed",
    );
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "reduced-access",
    );
    expect(linearGrant(saved.connectionId, "app")?.refreshToken).toBe(
      "reduced-refresh",
    );
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  });
  it("uses public S256 PKCE, registered callback and the app actor's selected scopes", async () => {
    const { id, transaction } = await pending();
    const url = new URL(navigate.mock.calls[0]?.[0]);
    expect(url.origin + url.pathname).toBe(
      "https://linear.app/oauth/authorize",
    );
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.org/OpenSesame/auth/linear.html",
    );
    expect(url.searchParams.get("state")).toBe(transaction.state);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(transaction.verifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
    expect(url.href).not.toContain(transaction.verifier);
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      transaction.verifier,
    );
    expect(deviceConnection(id)?.status).toBe("pending");
  });

  it("exchanges the callback code, verifies identity, and commits usable scopes only once", async () => {
    const { id, transaction } = await pending();
    const fetcher = linearAnswers(
      { body: linearToken },
      { body: { data: linearAccount } },
    );
    const [first, second] = await Promise.all([
      finishLinearAuthorization(callback(transaction.state)),
      finishLinearAuthorization(callback(transaction.state)),
    ]);
    expect(first?.status).toBe("active");
    expect(second?.connectionId).toBe(id);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(JSON.stringify(readDeviceRows())).not.toContain("private-access");
    const form = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(form.get("code_verifier")).toBe(transaction.verifier);
    expect(form.has("client_secret")).toBe(false);
    expect(replaceAddress).toHaveBeenCalled();
    await expect(
      finishLinearAuthorization(callback(transaction.state)),
    ).rejects.toThrow("already used");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("separates app and user consent and refuses to activate until both complete", async () => {
    const options = {
      ...linearOptions,
      appScopes: ["read", "issues:create"],
      userScopes: ["read"],
    };
    const saved = await configureLinearConnector(linearDraft("oauth"), options);
    const app = pendingLinear(saved.connectionId);
    linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
    await finishLinearAuthorization(callback(app.state));
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
    const user = pendingLinear(saved.connectionId);
    expect(user.actor).toBe("user");
    expect(
      new URL(navigate.mock.calls.at(-1)?.[0]).searchParams.get("scope"),
    ).toBe("read");
    linearAnswers(
      { body: { ...linearToken, access_token: "user-access", scope: "read" } },
      { body: { data: linearAccount } },
    );
    const done = await finishLinearAuthorization(callback(user.state));
    expect(done?.status).toBe("active");
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "private-access",
    );
    expect(linearGrant(saved.connectionId, "user")?.accessToken).toBe(
      "user-access",
    );
  });

  it("rejects unmatched, repeated and ambiguous state without contacting Linear", async () => {
    const { id, transaction } = await pending();
    const fetcher = linearAnswers();
    await expect(
      finishLinearAuthorization(callback("attacker-state")),
    ).rejects.toThrow("could not be matched");
    await expect(
      finishLinearAuthorization(
        `${callback(transaction.state)}&linear_state=other`,
      ),
    ).rejects.toThrow("Invalid");
    await expect(
      finishLinearAuthorization(
        `${callback(transaction.state)}&linear_error=access_denied`,
      ),
    ).rejects.toThrow("Invalid");
    expect(pendingLinear(id).state).toBe(transaction.state);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("consumes declined and expired transactions without claiming any provider permission", async () => {
    const first = await pending();
    const fetcher = linearAnswers();
    await expect(
      finishLinearAuthorization(
        `?linear_state=${first.transaction.state}&linear_error=access_denied`,
      ),
    ).rejects.toThrow("declined");
    expect(readDeviceSecrets()[first.id]?.linear_pending).toBeUndefined();
    const second = await pending();
    await updateLinearRecord(second.id, async (record) => ({
      ...record,
      secrets: {
        ...record.secrets,
        linear_pending: JSON.stringify({
          ...second.transaction,
          createdAt: Date.now() - 11 * 60_000,
        }),
      },
    }));
    await expect(
      finishLinearAuthorization(callback(second.transaction.state)),
    ).rejects.toThrow("expired");
    expect(linearGrant(second.id, "app")).toBeNull();
    expect(deviceConnection(second.id)?.status).toBe("pending");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revokes a grant when Linear did not grant selected scopes", async () => {
    const { id, transaction } = await pending();
    const fetcher = linearAnswers(
      { body: { ...linearToken, scope: "" } },
      { body: null },
      { body: null },
    );
    await expect(
      finishLinearAuthorization(callback(transaction.state)),
    ).rejects.toThrow("did not grant");
    expect(linearGrant(id, "app")).toBeNull();
    expect(
      fetcher.mock.calls
        .slice(1)
        .every(
          ([url]) => String(url) === "https://api.linear.app/oauth/revoke",
        ),
    ).toBe(true);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it("revokes a valid grant if the provider workspace differs from the selected one", async () => {
    const { id, transaction } = await pending();
    const fetcher = linearAnswers(
      { body: linearToken },
      {
        body: {
          data: {
            ...linearAccount,
            organization: { id: "other", name: "Other", urlKey: "other" },
          },
        },
      },
      { body: null },
      { body: null },
    );
    await expect(
      finishLinearAuthorization(callback(transaction.state)),
    ).rejects.toThrow("does not match");
    expect(linearGrant(id, "app")).toBeNull();
    expect(
      fetcher.mock.calls
        .slice(2)
        .every(
          ([url]) => String(url) === "https://api.linear.app/oauth/revoke",
        ),
    ).toBe(true);
    expect(fetcher.mock.calls.length).toBeGreaterThan(2);
  });

  it("revokes a provider grant if encrypted grant storage fails", async () => {
    const { id, transaction } = await pending();
    const write = vi.mocked(kvSeams.kvSetDurable).getMockImplementation();
    if (!write) throw new Error("Storage test seam missing");
    vi.mocked(kvSeams.kvSetDurable).mockImplementation(async (key, value) => {
      if (value.includes("private-access"))
        throw new Error("Grant write failed");
      return write(key, value);
    });
    const fetcher = linearAnswers(
      { body: linearToken },
      { body: { data: linearAccount } },
      { body: null },
      { body: null },
    );
    await expect(
      finishLinearAuthorization(callback(transaction.state)),
    ).rejects.toThrow("Grant write failed");
    expect(linearGrant(id, "app")).toBeNull();
    expect(deviceConnection(id)?.status).toBe("pending");
    expect(fetcher.mock.calls.length).toBeGreaterThan(2);
  });

  it("refuses a configuration changed after consent began", async () => {
    const { id, transaction } = await pending();
    const saved = linearConfiguration(id);
    await updateLinearRecord(id, async (record) => ({
      ...record,
      row: {
        ...record.row,
        fields: {
          ...record.row.fields,
          self_hosted_configuration: JSON.stringify({
            ...saved,
            options: { ...saved.options, appScopes: ["read", "write"] },
          }),
        },
      },
    }));
    const fetcher = linearAnswers();
    await expect(
      finishLinearAuthorization(callback(transaction.state)),
    ).rejects.toThrow("changed during consent");
    expect(fetcher).not.toHaveBeenCalled();
    expect(linearGrant(id, "app")).toBeNull();
  });
});
