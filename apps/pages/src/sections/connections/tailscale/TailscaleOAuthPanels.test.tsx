/** @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeFixture,
  fixture,
  mount,
  port,
  register,
  resetFixture,
} from "./tailscale-ui.test-support.js";
beforeEach(resetFixture);
afterEach(closeFixture);
it("renders shared configuration fields and a generated deployment app name without the old unsupported refusal", async () => {
  mount();
  expect(
    (await screen.findByLabelText("App name")).getAttribute("value"),
  ).toMatch(/^OpenSesame /);
  expect(
    screen.getByLabelText("Tailscale API base URL").getAttribute("value"),
  ).toBe("https://api.tailscale.com/");
  expect(
    screen.getByLabelText("Redirect URI to register").hasAttribute("readonly"),
  ).toBe(true);
  expect(
    screen.queryByText(/device enrollment requires tailscaled/),
  ).toBeNull();
});
it("registers and verifies an app without rendering its generated secret or retaining the bootstrap token", async () => {
  mount();
  await register();
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(
    screen.getByLabelText("Registered client ID").getAttribute("value"),
  ).toBe("generated-operator-id");
  expect(screen.queryByLabelText("Admin API access token")).toBeNull();
  expect(document.body.textContent).not.toContain(
    "private-generated-app-secret",
  );
  expect(screen.queryByDisplayValue("private-generated-app-secret")).toBeNull();
});
it("performs consent and returns a concealed single-use key without claiming device enrollment", async () => {
  mount();
  await register();
  fireEvent.click(
    screen.getByRole("button", { name: "Authorize a device with Tailscale" }),
  );
  const key = await screen.findByLabelText("Single-use auth key");
  expect(key.getAttribute("type")).toBe("password");
  expect(key.getAttribute("value")).toBe("issued-one-use-device-key");
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(
    screen.getByText(
      /Device enrollment is completed by that device's Tailscale client/,
    ),
  ).toBeTruthy();
  act(() => {
    for (const lock of fixture.locks) lock();
  });
  expect(screen.queryByLabelText("Single-use auth key")).toBeNull();
});
it("requires a second explicit action before forgetting the local app", async () => {
  mount();
  await register();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove local Tailscale app configuration",
    }),
  );
  expect(fixture.saved).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Confirm remove local Tailscale app configuration",
    }),
  );
  await waitFor(() => expect(fixture.saved).toBeNull());
});
it("refuses guest registration before sending bootstrap credentials", async () => {
  fixture.guest = true;
  mount();
  fireEvent.click(screen.getByText("Direct API registration"));
  fireEvent.change(await screen.findByLabelText("Admin API access token"), {
    target: { value: "fixture-admin" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Register app with Tailscale" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Register app with Tailscale" }),
  );
  await waitFor(() => expect(fixture.flash).toHaveBeenCalled());
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(
    screen.getByLabelText("Admin API access token").getAttribute("value"),
  ).toBe("");
});

it("imports actual app responses into vault custody without HTTP and reports unverified status", async () => {
  mount();
  const name = screen.getByLabelText("App name").getAttribute("value");
  const app = {
    id: "manually-issued-client-id",
    name,
    clientSecret: "returned-vendor-secret",
    redirectURIs: [port.redirectUri],
    scopes: ["auth_keys:create:once"],
  };
  fireEvent.change(await screen.findByLabelText("Returned OAuth app JSON"), {
    target: { value: JSON.stringify(app) },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save returned Tailscale app" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save returned Tailscale app" }),
  );
  await screen.findByLabelText("Registered client ID");
  expect(fixture.app).toEqual(app);
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue("returned-vendor-secret")).toBeNull();
  expect(
    screen.getAllByLabelText(
      /App credentials saved in this vault. Vendor verification is pending/,
    ).length,
  ).toBeGreaterThan(0);
});
it("prepares a manual device key handoff entirely offline and never invents expiry or verification", async () => {
  mount();
  fireEvent.change(await screen.findByLabelText("Issued device auth key"), {
    target: { value: "user-issued-opaque-device-key" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Prepare device key handoff" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare device key handoff" }),
  );
  const key = await screen.findByLabelText("Unverified device auth key");
  expect(key.getAttribute("type")).toBe("password");
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "validity, expiry and reuse policy are unverified",
  );
  act(() => {
    for (const lock of fixture.locks) lock();
  });
  expect(screen.queryByLabelText("Unverified device auth key")).toBeNull();
});
it("reports direct browser access refusal and still offers the registration artifact", async () => {
  fixture.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
  mount();
  fireEvent.click(screen.getByText("Direct API registration"));
  fireEvent.change(await screen.findByLabelText("Admin API access token"), {
    target: { value: "fixture-admin" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Register app with Tailscale" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Register app with Tailscale" }),
  );
  await waitFor(() => expect(fixture.flash).toHaveBeenCalled());
  expect(
    screen.getByRole("button", { name: "Download registration request" }),
  ).toBeTruthy();
  expect(
    screen.getByLabelText("Admin API access token").getAttribute("value"),
  ).toBe("");
  expect(fixture.saved).toBeNull();
});
it("editing the actual credential clears a published device key with unchanged metadata", async () => {
  mount();
  await register();
  fireEvent.click(
    screen.getByRole("button", { name: "Authorize a device with Tailscale" }),
  );
  await screen.findByLabelText("Single-use auth key");
  if (!fixture.app) throw new Error("Missing fixture app");
  act(() => {
    if (fixture.app)
      fixture.app = { ...fixture.app, clientSecret: "edited-vault-credential" };
    for (const change of fixture.changes) change();
  });
  expect(screen.queryByLabelText("Single-use auth key")).toBeNull();
});
it("editing an unchanged-reference credential while exchange is pending rejects its late response", async () => {
  mount();
  await register();
  let resolve: ((response: Response) => void) | undefined;
  fixture.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Authorize a device with Tailscale" }),
  );
  await waitFor(() => expect(resolve).toBeTruthy());
  act(() => {
    if (fixture.app)
      fixture.app = { ...fixture.app, clientSecret: "edited-during-exchange" };
    for (const change of fixture.changes) change();
  });
  await act(async () => {
    resolve?.(
      Response.json({
        access_token: "late-old-secret-key",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
  });
  expect(screen.queryByLabelText("Single-use auth key")).toBeNull();
  expect(screen.queryByDisplayValue("late-old-secret-key")).toBeNull();
});
