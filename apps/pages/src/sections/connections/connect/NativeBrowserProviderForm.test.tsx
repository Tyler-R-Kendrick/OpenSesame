/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import {
  nativeUiController,
  nativeUiView,
} from "./native-connector-ui.test-support.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

afterEach(cleanup);

it.each(["google", "microsoft"])(
  "uses the compiled %s public form without sending registration-only fields",
  async (id) => {
    const plan = connectPlan(id);
    const profile = nativeBrowserOAuthProfile(id);
    if (!plan || !profile)
      throw new Error("Public browser provider contract missing");
    const descriptor = nativeProviderDescriptor(plan, {
      callbackUrl: "https://app.example/connect/native-callback",
      apiKey: { available: false },
      oauth: { available: true, profile },
      mcp: { available: false, actor: "mcp" },
    });
    const view = nativeUiView();
    view.providerId = id;
    view.configuration.providerId = id;
    view.configuration.method = "oauth";
    view.configuration.parameters = { client_id: "public-browser-client" };
    view.configuration.requestedScopes = { user: [...profile.requiredScopes] };
    view.identity = {
      id: "authorized-user",
      label: "Authorized user",
      kind: "account",
      assurance: "account-verified",
    };
    view.grants = [
      {
        actor: "user",
        label: `${profile.name} authorization`,
        permissionState: "known",
        grantedScopes: [...profile.requiredScopes],
        expiresAt: null,
        needsReauth: false,
      },
    ];
    const controller = nativeUiController(view);
    controller.connect.mockResolvedValue(view);
    const onChanged = vi.fn();
    const onFlash = vi.fn();
    render(
      <NativeConnectorForm
        descriptor={descriptor}
        controller={controller}
        onChanged={onChanged}
        onFlash={onFlash}
      />,
    );
    expect(screen.queryByLabelText("Connector name")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await userEvent.type(
      screen.getByLabelText(`${profile.name} public client ID`),
      "public-browser-client",
    );
    await userEvent.click(
      screen.getByText("Sign-in options", { selector: "summary" }),
    );
    const registration = screen.getByLabelText(
      id === "google" ? "Authorized JavaScript origin" : "OAuth callback URL",
    );
    expect(registration).toHaveProperty("readOnly", true);
    await userEvent.click(
      screen.getByRole("button", { name: `Sign in to ${plan.name}` }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(view));
    expect(controller.connect).toHaveBeenCalledOnce();
    expect(controller.configure).not.toHaveBeenCalled();
    expect(onFlash).toHaveBeenCalledWith({
      tone: "ok",
      text: `${plan.name} access verified and saved on this device.`,
    });
    const sent = controller.connect.mock.calls[0]?.[0];
    expect(sent?.parameters).toEqual(
      id === "google"
        ? { client_id: "public-browser-client" }
        : { client_id: "public-browser-client", tenant: "common" },
    );
    expect(sent?.credentials).toEqual({});
    for (const scope of profile.requiredScopes)
      expect(sent?.requestedScopes.user).toContain(scope);
    expect(JSON.stringify(sent)).not.toContain("redirect_uri");
    expect(JSON.stringify(sent)).not.toContain("javascript_origin");
  },
);
