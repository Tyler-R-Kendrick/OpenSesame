import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
/** @vitest-environment jsdom */
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sectionCategory } from "./CapabilitySections.js";
import {
  installPanelFixture,
  renderPanel,
} from "./capabilities-panel.test-support.js";

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

  it("draws a capability's panel inside its own section and nowhere else", () => {
    contribute("plugin-surrogate-proxy", sectionCategory("feature-surrogates"));
    const { container } = renderPanel();
    const tile = screen.getByTestId("plugin-surrogate-proxy");
    expect(tile.closest("#feature-surrogates")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="plugin-surrogate-proxy"]'),
    ).toHaveLength(1);
  });
});
