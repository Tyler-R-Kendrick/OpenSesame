import { expect, it } from "vitest";
import { bindingCookieOf } from "./siop-rp-steps.mjs";

const rpUrl = "http://127.0.0.1:4111";
function jar(cookies) {
  return { cookies: async () => cookies };
}
function binding(state, domain = "127.0.0.1") {
  return {
    name: `__Host-siop_binding_${state}`,
    domain,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  };
}

it("selects the exact login binding among concurrent state-specific cookies", async () => {
  const first = binding("first");
  const second = binding("second");
  const context = jar([second, first]);
  expect(await bindingCookieOf(context, rpUrl, "first")).toBe(first);
  expect(await bindingCookieOf(context, rpUrl, "second")).toBe(second);
});

it("does not substitute another login's cookie after the requested binding is spent", async () => {
  expect(
    await bindingCookieOf(jar([binding("other")]), rpUrl, "spent"),
  ).toBeNull();
});

it("rejects a matching cookie at another host and the obsolete shared name", async () => {
  expect(
    await bindingCookieOf(
      jar([
        binding("requested", "attacker.example"),
        { ...binding("requested"), name: "__Host-siop_binding" },
      ]),
      rpUrl,
      "requested",
    ),
  ).toBeNull();
});

it.each([undefined, null, "", "bad;state"])(
  "requires an exact state instead of an ambiguous lookup %s",
  async (state) => {
    await expect(
      bindingCookieOf(jar([binding("unrelated")]), rpUrl, state),
    ).rejects.toThrow("exact login state");
  },
);
