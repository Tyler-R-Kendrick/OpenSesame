import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  nativeAuthFieldObservation,
  nativeAuthFieldViolations,
} from "./native-browser-auth-field-contract.mjs";
import {
  NATIVE_CANONICAL_PROVIDERS,
  nativeAuthFieldMethods,
} from "./native-browser-catalog-projection.mjs";

const input = (label, type = "url", readOnly = false) => ({
  label,
  type,
  readOnly,
});
function observe(method, selections = {}) {
  return {
    methodLabel: method.label,
    methodChoiceCount: 1,
    selections,
    inputs: [],
  };
}
function oauth(id) {
  const methods = nativeAuthFieldMethods(id);
  const method = methods.find((row) => row.id === "oauth");
  if (!method) throw new Error(`Missing ${id} OAuth contract`);
  const selector = method.fields.find((row) => row.id === "token_auth_method");
  return { methods, method, selector };
}

describe("canonical auth field ownership", () => {
  it.each(["resend", "workos", "salesforce"])(
    "admits only the registered OAuth mode's fields for %s",
    (id) => {
      const { methods, method, selector } = oauth(id);
      for (const mode of [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ]) {
        const observed = observe(method, { [selector.label]: mode });
        observed.inputs = [
          input("Token endpoint"),
          input("Authorization endpoint"),
        ];
        expect(nativeAuthFieldViolations(methods, observed)).toEqual([]);
        observed.inputs.push(input("OAuth client secret", "password"));
        expect(nativeAuthFieldViolations(methods, observed)).toHaveLength(
          mode === "none" ? 1 : 0,
        );
        observed.inputs.push(input("Arbitrary Client secret", "password"));
        expect(nativeAuthFieldViolations(methods, observed)).toContainEqual(
          input("Arbitrary Client secret", "password"),
        );
      }
    },
  );

  it.each(["resend", "workos", "vercel"])(
    "keeps provider/CIMD mode free of confidential and arbitrary OAuth controls for %s",
    (id) => {
      const { methods, method, selector } = oauth(id);
      const observed = observe(method, {
        [selector.label]: selector.defaultValue,
      });
      observed.inputs = [
        input("Token endpoint"),
        input("OAuth client secret", "password"),
      ];
      expect(nativeAuthFieldViolations(methods, observed)).toEqual(
        observed.inputs,
      );
    },
  );
});

describe("auth control refusals", () => {
  it("fails closed on absent, ambiguous or unsupported method/mode", () => {
    const { methods, method, selector } = oauth("workos");
    const observed = observe(method, {
      [selector.label]: "client_secret_basic",
    });
    observed.inputs = [input("OAuth client secret", "password")];
    expect(
      nativeAuthFieldViolations(methods, {
        ...observed,
        methodLabel: "API Key",
      }),
    ).toEqual(observed.inputs);
    expect(nativeAuthFieldViolations([], observed)).toEqual(observed.inputs);
    expect(nativeAuthFieldViolations([...methods, method], observed)).toEqual(
      observed.inputs,
    );
    expect(
      nativeAuthFieldViolations(methods, { ...observed, selections: {} }),
    ).toEqual(observed.inputs);
    expect(
      nativeAuthFieldViolations(methods, {
        ...observed,
        selections: { [selector.label]: "unexpected" },
      }),
    ).toEqual(observed.inputs);
    expect(
      nativeAuthFieldViolations(methods, { ...observed, methodLabel: null }),
    ).toEqual(observed.inputs);
    expect(
      nativeAuthFieldViolations(methods, {
        ...observed,
        methodLabel: null,
        methodChoiceCount: 0,
      }),
    ).toEqual([]);
  });

  it("requires password masking and rejects writable public fields", () => {
    const { methods, method, selector } = oauth("workos");
    const observed = observe(method, {
      [selector.label]: "client_secret_basic",
    });
    observed.inputs = [input("OAuth client secret", "text")];
    expect(nativeAuthFieldViolations(methods, observed)).toEqual(
      observed.inputs,
    );
    const locked = {
      label: "Public",
      fields: [
        { label: "Server URL", kind: "url", secret: false, readOnly: true },
      ],
    };
    expect(
      nativeAuthFieldViolations([locked], {
        methodLabel: "Public",
        selections: {},
        inputs: [input("Server URL")],
      }),
    ).toHaveLength(1);
  });
});

describe("configured protocol controls", () => {
  it("uses only each canonical MCP authentication mode's documented controls", () => {
    const methods = nativeAuthFieldMethods("adobe");
    const method = methods.find((row) => row.id === "mcp");
    for (const mode of ["bearer", "header", "anonymous", "oauth"]) {
      const observed = observe(method, { "MCP authentication": mode });
      observed.inputs = [input("MCP server endpoint")];
      expect(nativeAuthFieldViolations(methods, observed)).toHaveLength(
        mode === "oauth" ? 1 : 0,
      );
      observed.inputs = [input("MCP credential", "password")];
      expect(nativeAuthFieldViolations(methods, observed)).toHaveLength(
        ["bearer", "header"].includes(mode) ? 0 : 1,
      );
      observed.inputs = [input("OAuth client secret", "password")];
      expect(nativeAuthFieldViolations(methods, observed)).toHaveLength(1);
    }
  });

  it("retains the Google registered mode when popup isolation prevents provider consent", () => {
    const methods = nativeAuthFieldMethods("google");
    const method = methods.find(
      (row) => row.label === "Bring Your Own OAuth App",
    );
    const observed = observe(method, {
      "Token endpoint authentication": "none",
    });
    observed.inputs = [input("Token endpoint")];
    expect(nativeAuthFieldViolations(methods, observed)).toEqual([]);
  });

  it("admits only the registered client-credential method's secret", () => {
    for (const { id } of NATIVE_CANONICAL_PROVIDERS) {
      const methods = nativeAuthFieldMethods(id);
      for (const method of methods.filter((row) => row.id !== "oauth")) {
        const observed = observe(method);
        observed.inputs = [input("OAuth client secret", "password")];
        expect(
          nativeAuthFieldViolations(methods, observed),
          `${id}/${method.id}`,
        ).toEqual(
          id === "tailscale" && method.id === "api-key" ? [] : observed.inputs,
        );
        observed.inputs = [
          input("Unregistered OAuth client secret", "password"),
        ];
        expect(
          nativeAuthFieldViolations(methods, observed),
          `${id}/${method.id}: unregistered control`,
        ).toEqual(observed.inputs);
      }
    }
  });

  it("keeps Tailscale's fixed client-credential road masked and provider-owned", () => {
    const methods = nativeAuthFieldMethods("tailscale");
    const method = methods.find((row) => row.id === "api-key");
    expect(method.fields).toContainEqual(
      expect.objectContaining({
        id: "client_secret",
        label: "OAuth client secret",
        secret: true,
      }),
    );
    const observed = observe(method);
    observed.inputs = [input("OAuth client secret", "password")];
    expect(nativeAuthFieldViolations(methods, observed)).toEqual([]);
    for (const control of [
      input("OAuth client secret", "text"),
      input("Token endpoint"),
      input("Arbitrary Client secret", "password"),
    ]) {
      observed.inputs = [control];
      expect(nativeAuthFieldViolations(methods, observed)).toEqual([control]);
    }
  });

  it("observes the actual radio, labeled selects and input types without reading secrets", () => {
    const dom = new JSDOM();
    const form = dom.window.document.createElement("fieldset");
    form.innerHTML =
      '<div class="cx-modes"><label><input type="radio" checked>OAuth application</label></div><label for="mode">OAuth application</label><select id="mode"><option value="client_secret_basic" selected>Basic</option></select><label for="secret">OAuth client secret</label><input id="secret" type="password" value="do-not-collect"><label for="endpoint">Token endpoint</label><input id="endpoint" type="url" readonly>';
    const observed = nativeAuthFieldObservation(form);
    expect(observed.methodLabel).toBe("OAuth application");
    expect(observed.selections).toEqual({
      "OAuth application": "client_secret_basic",
    });
    expect(observed.inputs).toContainEqual(
      input("OAuth client secret", "password"),
    );
    expect(observed.inputs).toContainEqual(
      input("Token endpoint", "url", true),
    );
    expect(JSON.stringify(observed)).not.toContain("do-not-collect");
    dom.window.close();
  });
});
