import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { jitlessOrderProblem } from "./lib/zod-jitless-order.mjs";
import { zodJitlessIntro } from "./zod-jitless-intro.mjs";

const ZOD_CORE =
  "/repo/node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/core.js";
const ZOD_V3 =
  "/repo/node_modules/.pnpm/zod@3.25.67/node_modules/zod/v3/types.js";
const APP = "/repo/packages/app-core/src/lib/identity.ts";

describe("the intro of a chunk that holds zod 4's core", () => {
  test("switches zod to jitless before the chunk's own code", () => {
    const intro = zodJitlessIntro({ moduleIds: [APP, ZOD_CORE] });
    const zod = 'const t=r("$ZodType",(e,n)=>{});';
    // A page that evaluates that chunk first, and builds a schema in the next.
    const chunks = {
      "main.js": { imports: ["zod.js", "schemas.js"], code: "" },
      "zod.js": { code: `${intro}${zod}` },
      "schemas.js": { imports: ["zod.js"], code: "t.object({});" },
    };
    assert.equal(
      jitlessOrderProblem(
        "main.js",
        (file) => chunks[file]?.imports ?? [],
        (file) => chunks[file]?.code ?? "",
      ),
      null,
    );
    // The same chunk without the intro is the problem the intro exists for.
    chunks["zod.js"].code = zod;
    assert.notEqual(
      jitlessOrderProblem(
        "main.js",
        (file) => chunks[file]?.imports ?? [],
        (file) => chunks[file]?.code ?? "",
      ),
      null,
    );
  });

  test("is empty for a chunk without zod 4's core, zod 3 included", () => {
    assert.equal(zodJitlessIntro({ moduleIds: [APP] }), "");
    assert.equal(zodJitlessIntro({ moduleIds: [ZOD_V3] }), "");
  });

  test("reads Windows paths the same way", () => {
    assert.notEqual(
      zodJitlessIntro({ moduleIds: [ZOD_CORE.replaceAll("/", "\\")] }),
      "",
    );
  });
});
