import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import { nativeOAuthCarrierFixture } from "@opensesame/app-core/lib/native-oauth-carrier.test-support.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "@opensesame/app-core/lib/native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "@opensesame/app-core/lib/native-oauth-client-exchange.js";
import { verifyNativeOAuthResource } from "@opensesame/app-core/lib/native-oauth-resource.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { nativeVerified } from "./native-connector-ui-values.js";
import {
  type NativeMethodDescriptor,
  nativeMethodConfigurable,
} from "./native-connector-ui.js";
import {
  nativeUiController,
  nativeUiDescriptor,
} from "./native-connector-ui.test-support.js";
import { nativePolicyMethod } from "./native-provider-policy.js";

afterEach(cleanup);
function oauth(): NativeMethodDescriptor {
  return {
    id: "oauth",
    label: "OAuth",
    available: true,
    fields: [
      {
        id: "client_id",
        label: "Client ID",
        kind: "text",
        secret: false,
        required: true,
      },
    ],
    scopeGroups: [],
  };
}
function carrier(origins: readonly string[]) {
  let live = true;
  const captures = vi.fn();
  const captured: NativeProviderTransport = {
    fetch: vi.fn(),
    assertCurrent: () => {
      if (!live) throw new Error("original node withdrawn");
    },
    supportsNativeOrigin: (origin) => live && origins.includes(origin),
  };
  const release = bindNativeProviderTransport({
    ...captured,
    capture: () => {
      captures();
      return captured;
    },
  });
  return {
    captures,
    release,
    withdraw: () => {
      live = false;
    },
  };
}
it("keeps the compiled editor open without authorizing Connect", () => {
  const method = nativePolicyMethod("resend", oauth());
  expect(method.available).toBe(false);
  expect(nativeMethodConfigurable(method)).toBe(true);
  const controller = nativeUiController();
  render(
    <MemoryRouter>
      <NativeConnectorForm
        descriptor={{
          ...nativeUiDescriptor(),
          providerId: "resend",
          name: "Resend",
          methods: [method],
        }}
        controller={controller}
        onChanged={vi.fn()}
        onFlash={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByLabelText("Client ID")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Sign in to Resend" }),
  ).toHaveProperty("disabled", true);
  expect(controller.connect).not.toHaveBeenCalled();
  expect(controller.configure).not.toHaveBeenCalled();
  expect(controller.invoke).not.toHaveBeenCalled();
});
it("admits the actual captured Resend token and identity targets and refuses withdrawn or retargeted authority", () => {
  const denied = nativePolicyMethod("resend", oauth());
  expect(denied.available).toBe(false);
  expect(denied.runtimeAvailable).toBe(true);
  const node = carrier(["https://api.resend.com"]);
  try {
    expect(nativePolicyMethod("resend", denied).available).toBe(true);
    expect(node.captures).toHaveBeenCalledTimes(1);
    expect(
      nativePolicyMethod("resend", denied, {
        token_endpoint: "https://other.test/token",
        resource: "https://api.resend.com/domains",
      }).available,
    ).toBe(false);
    node.withdraw();
    expect(nativePolicyMethod("resend", denied).available).toBe(false);
  } finally {
    node.release();
  }
});
it("requires both actual origins and preserves unavailable compiled drivers and product policy", () => {
  const node = carrier(["https://api.resend.com"]);
  try {
    expect(
      nativePolicyMethod("resend", oauth(), {
        token_endpoint: "https://api.resend.com/oauth/token",
        resource: "https://other.test/resource",
      }).available,
    ).toBe(false);
    expect(
      nativePolicyMethod("resend", oauth(), {
        token_endpoint: "https://api.resend.com/oauth/token",
      }).available,
    ).toBe(false);
    expect(
      nativePolicyMethod("resend", { ...oauth(), available: false }).available,
    ).toBe(false);
    const uncompiled = nativePolicyMethod(
      "resend",
      {
        ...oauth(),
        available: false,
        configurable: true,
      },
      {
        token_endpoint: "https://other.test/token",
        resource: "https://api.resend.com/domains",
      },
    );
    expect(uncompiled.runtimeAvailable).toBe(false);
    expect(nativeMethodConfigurable(uncompiled)).toBe(true);
    expect(nativePolicyMethod("resend", uncompiled).available).toBe(false);
    const policy = {
      ...oauth(),
      available: false,
      configurable: true,
      unavailableKind: "policy" as const,
    };
    expect(nativePolicyMethod("resend", policy)).toBe(policy);
    expect(nativeMethodConfigurable(policy)).toBe(false);
  } finally {
    node.release();
  }
});

it("projects only an actual verified HTTPS grant while its original native route is available", async () => {
  const f = await nativeOAuthCarrierFixture();
  try {
    const saved = await configureNativeOAuthClient(f.input, f.owner);
    expect(saved.status).toBe("configuration");
    expect(nativeVerified(saved)).toBe(false);
    const consent = new URL(
      await beginNativeOAuthClient(saved.connectionId, f.owner),
    );
    f.state.challenge = consent.searchParams.get("code_challenge") ?? "";
    await exchangeNativeOAuthClient(
      new URLSearchParams({
        native_state: consent.searchParams.get("state") ?? "",
        native_code: "one-use-code",
      }).toString(),
      f.owner,
    );
    expect(nativeVerified(saved)).toBe(false);
    const verified = await verifyNativeOAuthResource(
      saved.connectionId,
      f.owner,
    );
    expect(verified.body).toEqual({
      projects: [{ id: "project-42", name: "Actual configured project" }],
    });
    expect(nativeVerified(verified.view)).toBe(true);
    const timestamp = verified.view.verifiedAt;
    expect(timestamp).not.toBeNull();
    expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
    f.withdrawRoute();
    expect(nativeVerified(verified.view)).toBe(false);
    expect(verified.view.verifiedAt).toBe(timestamp);
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});
