/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("lets the user retry blocked popup reservation without navigation or exposing credentials", async () => {
  mount();
  await register();
  const release = vi.fn();
  const prepare = vi
    .spyOn(port, "prepareAuthorization")
    .mockImplementationOnce(() => {
      throw new Error("The browser blocked this popup");
    })
    .mockReturnValue(release);
  const authorize = screen.getByRole("button", {
    name: "Authorize a device with Tailscale",
  });
  fireEvent.click(authorize);
  expect(fixture.authorize).not.toHaveBeenCalled();
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText("Single-use auth key")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Cancel Tailscale operation" }),
  ).toBeNull();
  expect(authorize.hasAttribute("disabled")).toBe(false);
  fireEvent.click(authorize);
  const key = await screen.findByLabelText("Single-use auth key");
  expect(key.getAttribute("type")).toBe("password");
  expect(key.getAttribute("value")).toBe("issued-one-use-device-key");
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(fixture.authorize).toHaveBeenCalledOnce();
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain(
    "private-generated-app-secret",
  );
});
