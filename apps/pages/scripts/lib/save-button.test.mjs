/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

await import("../../public/save-button.js");

const VALUE = btoa(JSON.stringify({ title: "Login" }));

function button(vaultUrl) {
  const element = document.createElement("opensesame-save-button");
  element.setAttribute("value", VALUE);
  element.setAttribute("data-opensesame-type", "login");
  element.setAttribute("vault-url", vaultUrl);
  document.body.append(element);
  return element;
}

function saveButton(element) {
  const found = element.shadowRoot?.querySelector("button");
  if (!(found instanceof HTMLButtonElement)) throw new Error("button missing");
  return found;
}

afterEach(() => {
  for (const element of document.querySelectorAll("opensesame-save-button"))
    element.remove();
  vi.restoreAllMocks();
});

describe("save button vault transport", () => {
  it("refuses a cleartext remote vault for a secret payload", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const element = button("http://vault.example");
    const control = saveButton(element);
    expect(control.disabled).toBe(true);
    control.click();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    "https://consumer:password@vault.example",
    "http://vault.example:8443",
    "ftp://vault.example",
  ])("refuses an unusable vault URL %s", (url) => {
    expect(saveButton(button(url)).disabled).toBe(true);
  });

  it.each([
    "https://vault.example",
    "https://vault.example/base",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ])("accepts TLS, or loopback plain HTTP, at %s", (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const control = saveButton(button(url));
    expect(control.disabled).toBe(false);
    control.click();
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^https?:\/\/[^/]+\/(?:base\/)?save$/u),
      "opensesame-save",
      expect.any(String),
    );
  });
});
