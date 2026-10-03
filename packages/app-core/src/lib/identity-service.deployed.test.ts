import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { deployed: "", saved: "" };

vi.mock("./settings.js", () => ({
  defaultIdentityApi: () => state.deployed,
  loadSettings: () => ({}),
  saveSettings: vi.fn(),
}));
vi.mock("./device-identity.js", () => ({
  remoteIdentityApi: () => state.saved.replace(/\/+$/, ""),
}));
vi.mock("../screens/setup/ways-in-patch.js", () => ({
  applyWaysInPatch: (settings: object) => settings,
}));

import { signInServiceIsDeployed } from "./identity-service.js";

describe("signInServiceIsDeployed", () => {
  beforeEach(() => {
    state.deployed = "";
    state.saved = "";
  });

  it("is false when the deployment supplies nothing", () => {
    state.saved = "https://login.example.com";
    expect(signInServiceIsDeployed()).toBe(false);
  });

  it("is true when the address in use is the deployment's own, slashes aside", () => {
    state.deployed = "https://id.corp.example/";
    state.saved = "https://id.corp.example";
    expect(signInServiceIsDeployed()).toBe(true);
  });

  it("is false once a person has set a different address", () => {
    state.deployed = "https://id.corp.example";
    state.saved = "https://login.example.com";
    expect(signInServiceIsDeployed()).toBe(false);
  });
});
