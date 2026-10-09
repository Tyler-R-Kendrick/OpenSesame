import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  featureRequestSeams,
  sendFeatureOperation,
} from "./feature-request-send.js";

const original = featureRequestSeams.fetch;
const fetchSpy = vi.fn<typeof featureRequestSeams.fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response("{}"));
  featureRequestSeams.fetch = fetchSpy;
});

afterEach(() => {
  featureRequestSeams.fetch = original;
});

describe("sending a saved connector operation", () => {
  it("sends to the address the provider declares with bearer material on headers only", () => {
    const sent = sendFeatureOperation({
      ok: true,
      providerId: "anthropic",
      operation: "model.list",
      action: { scopes: "read" },
      secrets: { credential: "sk-secret" },
    });
    expect(sent.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/anthropic/model.list");
    expect(String(init?.body)).not.toContain("sk-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe("sk-secret");
  });

  it("sends nowhere for a provider that declares no address", () => {
    const sent = sendFeatureOperation({
      ok: true,
      providerId: "passwordstate",
      operation: "secret.configure",
      action: { base_url: "https://vault.example.test" },
      secrets: { api_key: "pw-secret" },
    });
    // The operation still stands for the feature that asked for it.
    expect(sent).toMatchObject({
      ok: true,
      providerId: "passwordstate",
      operation: "secret.configure",
    });
    // An address made up for it would be a request that can only fail.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tells the seam what was performed, sent or not", () => {
    const told = vi.fn();
    const performed = featureRequestSeams.performed;
    featureRequestSeams.performed = told;
    try {
      sendFeatureOperation({
        ok: true,
        providerId: "passwordstate",
        operation: "secret.configure",
        action: {},
        secrets: { api_key: "pw-secret" },
      });
      sendFeatureOperation({ ok: false, providerId: "passwordstate" });
    } finally {
      featureRequestSeams.performed = performed;
    }
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      providerId: "passwordstate",
    });
  });

  it("sends nothing when nothing is saved", () => {
    expect(
      sendFeatureOperation({ ok: false, providerId: "anthropic" }),
    ).toEqual({ ok: false, providerId: "anthropic" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps forge backup SSH material off the wire during a sync nudge", () => {
    const sshKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----";
    const sent = sendFeatureOperation({
      ok: true,
      providerId: "gitlab",
      operation: "project.read",
      action: {
        remote_url: "git@gitlab.com:group/repo.git",
        auth_mode: "ssh_key",
      },
      secrets: { ssh_private_key: sshKey, ssh_passphrase: "phrase" },
    });
    expect(sent.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still sends header-safe API secrets for providers with an address", () => {
    const sent = sendFeatureOperation({
      ok: true,
      providerId: "gitlab",
      operation: "project.read",
      action: { remote_url: "https://gitlab.com/group/repo.git" },
      secrets: { token: "glpat-backup-token" },
    });
    expect(sent.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("x-token")).toBe(
      "glpat-backup-token",
    );
    expect(String(init?.body)).not.toContain("glpat-backup-token");
  });
});
