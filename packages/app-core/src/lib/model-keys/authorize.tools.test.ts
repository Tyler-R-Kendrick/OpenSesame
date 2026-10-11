import { describe, expect, it } from "vitest";
import { ready } from "./harness.fixtures.test-support.js";
import { expectRefused } from "./harness.test-support.js";
import {
  ANTHROPIC_CASE,
  GEMINI_CASE,
  OPENAI_CASE,
  inspect,
  refusalOf,
} from "./tools.test-support.js";

describe.each([OPENAI_CASE, ANTHROPIC_CASE, GEMINI_CASE])(
  "tools on $protocol",
  (c) => {
    it("carries a plain function tool and chooses among them", () => {
      expect(() => inspect(c, c.body({ tools: c.wrap(c.tool) }))).not.toThrow();
      expect(() =>
        inspect(
          c,
          c.body({ tools: c.wrap(c.tool), [c.choiceField]: c.choice }),
        ),
      ).not.toThrow();
      expect(() => inspect(c, c.body({ tools: [] }))).not.toThrow();
    });

    for (const [label, priced] of Object.entries(c.priced)) {
      it(`refuses ${label}, a tool the provider runs and bills for`, () => {
        const refused = refusalOf(() =>
          inspect(c, c.body({ tools: c.wrap(priced) })),
        );
        expect({ error: refused.error, reason: refused.reason }).toEqual({
          error: "insufficient_scope",
          reason: "body.tool",
        });
      });

      it(`refuses ${label} beside a function tool`, () => {
        expect(
          refusalOf(() =>
            inspect(
              c,
              c.body({ tools: [...c.wrap(c.tool), ...c.wrap(priced)] }),
            ),
          ).reason,
        ).toBe("body.tool");
      });
    }

    it("refuses a key inside a tool that the protocol does not define", () => {
      const unknown = { ...c.tool, cache_control: { type: "ephemeral" } };
      expect(
        refusalOf(() => inspect(c, c.body({ tools: c.wrap(unknown) }))).reason,
      ).toBe("body.tool");
      const smuggled = { ...c.tool, web_search: {} };
      expect(
        refusalOf(() => inspect(c, c.body({ tools: c.wrap(smuggled) }))).reason,
      ).toBe("body.tool");
    });

    it("refuses tools that are not a list of objects", () => {
      for (const tools of [
        {},
        "web_search",
        7,
        [null],
        ["web_search"],
        [[]],
        [{}],
      ])
        expect(
          refusalOf(() => inspect(c, c.body({ tools }))).reason,
          JSON.stringify(tools),
        ).toBe("body.tool");
    });

    for (const choice of c.pricedChoices) {
      it(`refuses a ${c.choiceField} that names ${JSON.stringify(choice)}`, () => {
        expect(
          refusalOf(() =>
            inspect(
              c,
              c.body({ tools: c.wrap(c.tool), [c.choiceField]: choice }),
            ),
          ).reason,
        ).toBe("body.tool");
      });
    }
  },
);

describe("a tool the last hop refuses reaches nobody", () => {
  it("is refused by the broker before anything is reserved", async () => {
    const { h, signer, token } = await ready();
    await expectRefused(
      h.call(token, signer, {
        body: h.chat({ tools: [{ type: "web_search_preview" }] }),
      }),
      "insufficient_scope",
      "body.tool",
    );
    expect(h.broker.list()[0]?.remaining).toMatchObject({
      requests: 100,
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
    await expect(
      h.call(token, signer, {
        body: h.chat({
          tools: [
            { type: "function", function: { name: "weather", parameters: {} } },
          ],
        }),
      }),
    ).resolves.toBeDefined();
  });
});
