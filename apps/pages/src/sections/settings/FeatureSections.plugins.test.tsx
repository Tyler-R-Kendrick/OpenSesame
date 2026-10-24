import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sectionCategory } from "./FeatureSections.js";
import {
  installPanelFixture,
  renderFeatureConfig,
  renderPanel,
} from "./settings-panels.test-support.js";

installDoublePorts();

installPanelFixture();

let revokes: Array<() => void> = [];

function contribute(id: string, category: string) {
  revokes.push(
    registerContributionForTest("settings-panel", {
      id,
      label: id,
      category,
      Panel: () => <div data-testid={id}>{id}</div>,
      order: 10,
    }),
  );
}

describe("the runtime-installed plugins' sections (ADR 0150 §7)", () => {
  afterEach(() => {
    for (const revoke of revokes) revoke();
    revokes = [];
  });

  it("draws each plugin as its own section under its own subheader", () => {
    const { container } = renderPanel();
    for (const [id, title] of [
      ["feature-surrogates", "Surrogate credentials"],
      ["feature-autofill", "Browser autofill"],
    ]) {
      const head = container.querySelector(`#${id} .capsection__title`);
      expect(head?.textContent, id).toBe(title);
    }
  });

  it("keeps a capability's panel off Features and draws it on its feature page", () => {
    contribute("plugin-surrogate-proxy", sectionCategory("feature-surrogates"));
    const list = renderPanel();
    expect(
      list.container.querySelector('[data-testid="plugin-surrogate-proxy"]'),
    ).toBeNull();
    cleanup();

    renderFeatureConfig("surrogates", "agents.surrogate-credentials");
    const tile = screen.getByTestId("plugin-surrogate-proxy");
    expect(tile.closest(".feature-config")).not.toBeNull();
  });
});
