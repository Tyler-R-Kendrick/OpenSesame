import { describe, expect, it } from "vitest";
import { AI_MODEL_PROVIDER_IDS } from "./ai-model-provider-ids.generated.js";
import { catalogProvider } from "./connector-catalog.js";
import { INTEGRATION_AI_LABS } from "./integration-ai-labs.js";

describe("the AI labs Settings › Integrations lists", () => {
  // ADR 0139: a target shows a subset only as a selection of catalog ids.
  it("names only model-provider rows of the integration catalog", () => {
    const notModelRows = INTEGRATION_AI_LABS.filter(
      (lab) => catalogProvider(lab.id)?.category !== "ai_model_provider",
    ).map((lab) => lab.id);
    expect(notModelRows).toEqual([]);
  });

  it("names rows the browser bundles", () => {
    const bundled = new Set<string>(AI_MODEL_PROVIDER_IDS);
    expect(
      INTEGRATION_AI_LABS.filter((lab) => !bundled.has(lab.id)).map(
        (lab) => lab.id,
      ),
    ).toEqual([]);
  });
});
