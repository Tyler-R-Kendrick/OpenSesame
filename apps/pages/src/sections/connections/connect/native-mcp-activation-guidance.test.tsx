/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";
import { nativeUiController } from "./native-connector-ui.test-support.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

afterEach(cleanup);

function linearMcpDescriptor(
  available: boolean,
  reason?: string,
): NativeConnectorDescriptor {
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Missing compiled Linear contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: "https://app.example/auth/native-connector.html",
    apiKey: { available: false },
    oauth: { available: false },
    mcp: { available, reason, actor: "user" },
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
          name: "Linear: External connectors inactive",
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
        mcp: { available: false, actor: "user" },
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
