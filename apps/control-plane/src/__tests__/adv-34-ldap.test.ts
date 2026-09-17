import type { OrgLdapConfig } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  LdapConfigurationError,
  assertUsableLdapConfig,
} from "../interactions/ldap.js";

function production() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      allowDevDefaults: false,
    },
  }).ctx;
}

function config(url: string): OrgLdapConfig {
  return {
    organizationId: "org:ldap",
    url,
    bindMode: "bind_template",
    bindTemplate: "uid={username},ou=people,dc=example,dc=com",
    subjectAttribute: "entryUUID",
    attributeMap: {},
    groupRoleMap: {},
  };
}

function refusedCode(url: string): string | undefined {
  try {
    assertUsableLdapConfig(production(), config(url));
    return undefined;
  } catch (error) {
    if (error instanceof LdapConfigurationError) return error.code;
    throw error;
  }
}

describe("ADV-34 LDAP federation is not arbitrary network access", () => {
  it("refuses metadata, private, loopback, and cloud directory URLs", () => {
    for (const url of [
      "ldaps://169.254.169.254",
      "ldaps://10.1.2.3:636",
      "ldaps://127.0.0.1:636",
      "ldaps://localhost",
      "ldaps://[::1]:636",
      "ldaps://metadata.google.internal",
    ]) {
      expect(refusedCode(url), url).toBe("unsafe_host");
    }
  });

  it("refuses plain ldap:// once operator defaults are off", () => {
    expect(refusedCode("ldap://directory.example.com")).toBe("tls_required");
  });

  it("refuses a URL that is not LDAP", () => {
    expect(refusedCode("https://directory.example.com")).toBe("invalid_url");
  });
});
