import { expect, it } from "vitest";
import { vaultSecurityPage } from "./vault-app";
it("opens only the configured vault base without carrying credentials", () => {
  expect(vaultSecurityPage("https://vault.example/OpenSesame/")).toBe(
    "https://vault.example/OpenSesame/settings/security#retired-passwords",
  );
  expect(vaultSecurityPage("http://localhost:5180/")).toBe(
    "http://localhost:5180/settings/security#retired-passwords",
  );
});
it.each([
  "javascript:alert(1)",
  "https://user:secret@vault.example/",
  "https://vault.example/?token=secret",
  "http://remote.example/",
  "https://vault.example/#secret",
])("refuses unsafe vault navigation %s", (value) => {
  expect(() => vaultSecurityPage(value)).toThrow();
});
