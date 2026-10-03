import { afterEach, describe, expect, it } from "vitest";
import { deviceIdentitySeams } from "./device-identity.js";
import { signInServiceIsDeployed } from "./identity-service.js";
import { applyRuntimeConfig } from "./settings.js";

const realRemoteIdentityApi = deviceIdentitySeams.remoteIdentityApi;

function inUse(address: string): void {
  deviceIdentitySeams.remoteIdentityApi = () => address.replace(/\/+$/, "");
}

describe("signInServiceIsDeployed", () => {
  afterEach(() => {
    deviceIdentitySeams.remoteIdentityApi = realRemoteIdentityApi;
    applyRuntimeConfig({});
  });

  it("is false when the deployment supplies nothing", () => {
    applyRuntimeConfig({});
    inUse("https://login.example.com");
    expect(signInServiceIsDeployed()).toBe(false);
  });

  it("is true when the address in use is the deployment's own, slashes aside", () => {
    applyRuntimeConfig({ identityApi: "https://id.corp.example/" });
    inUse("https://id.corp.example");
    expect(signInServiceIsDeployed()).toBe(true);
  });

  it("is false once a person has set a different address", () => {
    applyRuntimeConfig({ identityApi: "https://id.corp.example" });
    inUse("https://login.example.com");
    expect(signInServiceIsDeployed()).toBe(false);
  });
});
