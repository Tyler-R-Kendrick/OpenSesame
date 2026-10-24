import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "../../../modules/connectors.external/genuine-runtime.test-support.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";
import { nativeUiController } from "./native-connector-ui.test-support.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

afterEach(cleanup);

function linearMcpDescriptor(
  available: boolean,
  reason?: string,
  inactiveReason?: string,
): NativeConnectorDescriptor {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Missing compiled Linear contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: false },
    mcp: { available, reason, inactiveReason, actor: "user" },
  });
  // The existing new-Linear settings route selects MCP; advanced OAuth/key
  // configuration retains its own owner and is not promoted by this test.
  return {
    ...descriptor,
    methods: descriptor.methods.filter((method) => method.id === "mcp"),
  };
}

describe("compiled MCP activation guidance", () => {
  it("renders missing activation truthfully without enabling authorization", () => {
    const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
    try {
      const descriptor = linearMcpDescriptor(false);
      expect(descriptor.methods[0]).toMatchObject({
        available: false,
        runtimeAvailable: false,
        unavailableKind: "runtime-inactive",
      });
      expect(descriptor.methods[0]?.unavailableReason).toContain(
        "Settings › Features",
      );
      const controller = nativeUiController();
      render(
        createElement(
          MemoryRouter,
          null,
          createElement(NativeConnectorForm, {
            descriptor,
            controller,
            onChanged: vi.fn(),
            onFlash: vi.fn(),
          }),
        ),
      );
      expect(
        screen.getByRole("img", {
          name: "Linear: Connection not active",
        }),
      ).toBeTruthy();
      expect(
        screen.getByText(/Enable External connectors in Settings › Features/),
      ).toBeTruthy();
      expect(
        screen.queryByText(/has not advertised|has no supported browser/),
      ).toBeNull();
      expect(
        screen.queryByRole("img", {
          name: /No public browser contract|Not built yet/,
        }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Sign in to Linear/ }),
      ).toBeNull();
      expect(controller.connect).not.toHaveBeenCalled();
      expect(controller.configure).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("keeps active authorization available and removes the inactive guidance", () => {
    const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
    try {
      const descriptor = linearMcpDescriptor(true);
      expect(descriptor.methods[0]).toMatchObject({
        available: true,
        runtimeAvailable: true,
      });
      expect(descriptor.methods[0]?.unavailableKind).toBeUndefined();
      const controller = nativeUiController();
      render(
        createElement(
          MemoryRouter,
          null,
          createElement(NativeConnectorForm, {
            descriptor,
            controller,
            onChanged: vi.fn(),
            onFlash: vi.fn(),
          }),
        ),
      );
      expect(
        screen.getByRole("button", { name: "Sign in to Linear" }),
      ).toHaveProperty("disabled", false);
      expect(
        screen.queryByText(/Enable External connectors in Settings › Features/),
      ).toBeNull();
      expect(controller.connect).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("retains explicit admission reasons instead of replacing them with activation advice", () => {
    const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
    try {
      const descriptor = linearMcpDescriptor(
        false,
        "Operator policy requires a different MCP endpoint.",
        "Open your own vault to connect this provider.",
      );
      expect(descriptor.methods[0]?.unavailableReason).toBe(
        "Operator policy requires a different MCP endpoint.",
      );
      expect(descriptor.methods[0]?.unavailableKind).not.toBe(
        "runtime-inactive",
      );
    } finally {
      release();
    }
  });

  it("retains real incomplete public metadata and explicit credential modes without promoting runtime", () => {
    const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
    try {
      const plan = connectPlan("hugging-face");
      if (!plan) throw new Error("Missing real incomplete MCP contract");
      const descriptor = nativeProviderDescriptor(plan, {
        callbackUrl: "https://app.example/auth/native-connector.html",
        apiKey: { available: false },
        oauth: { available: false },
        mcp: {
          available: false,
          inactiveReason: "Open your own vault to connect this provider.",
          actor: "user",
        },
      });
      const mcp = descriptor.methods.find((entry) => entry.id === "mcp");
      expect(mcp?.available).toBe(false);
      expect(mcp?.unavailableKind).toBe("no-public-contract");
      expect(mcp?.unavailableReason).toContain(
        "does not advertise public clients without a client secret",
      );
      expect(
        mcp?.fields
          .find((field) => field.id === "mcp_authentication")
          ?.choices?.map((choice) => choice.id),
      ).toEqual(["bearer", "header", "anonymous"]);
    } finally {
      release();
    }
  });
});

it("uses the actual guest, protected and locked vault guard for the displayed prerequisite", async () => {
  const release = bindNativeBrowserPolicyOrigin(() => "https://app.example");
  const provider = catalogProvider("linear");
  if (!provider) throw new Error("Missing compiled Linear provider");
  try {
    await closeGenuineRuntimeFixture();
    kvForgetAll();
    await vaultStore.createGuest();
    expect(vaultStore.isGenuineSession()).toBe(false);
    const guest = nativeSettingsDescriptor(provider);
    if (!guest) throw new Error("Missing native Linear descriptor");
    expect(guest.methods[0]).toMatchObject({
      available: false,
      runtimeAvailable: false,
      unavailableKind: "runtime-inactive",
    });
    const controller = nativeUiController();
    const rendered = render(
      createElement(
        MemoryRouter,
        null,
        createElement(NativeConnectorForm, {
          descriptor: guest,
          controller,
          onChanged: vi.fn(),
          onFlash: vi.fn(),
        }),
      ),
    );
    expect(
      screen.getByText(/Open your own vault to connect this provider/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Enable External connectors in Settings › Features/),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "Linear: Connection not active" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(controller.connect).not.toHaveBeenCalled();
    rendered.unmount();

    await genuineRuntimeFixture();
    expect(vaultStore.isGenuineSession()).toBe(true);
    const protectedVault = nativeSettingsDescriptor(provider);
    if (!protectedVault) throw new Error("Missing native Linear descriptor");
    expect(protectedVault.methods[0]?.available).toBe(false);
    expect(protectedVault.methods[0]?.unavailableReason).toContain(
      "Settings › Features",
    );
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(NativeConnectorForm, {
          descriptor: protectedVault,
          controller,
          onChanged: vi.fn(),
          onFlash: vi.fn(),
        }),
      ),
    );
    expect(
      screen.getByText(/Enable External connectors in Settings › Features/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Open your own vault to connect this provider/),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(controller.connect).not.toHaveBeenCalled();

    vaultStore.lock();
    expect(vaultStore.isGenuineSession()).toBe(false);
    expect(
      nativeSettingsDescriptor(provider)?.methods[0]?.unavailableReason,
    ).toContain("Open your own vault");
  } finally {
    cleanup();
    await closeGenuineRuntimeFixture();
    kvForgetAll();
    release();
  }
});
