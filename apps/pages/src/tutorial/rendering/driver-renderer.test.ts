/** @vitest-environment jsdom */

import type { GuideTargetId } from "@opensesame/guide-lang";
import { beforeEach, describe, expect, it } from "vitest";
import { ANNOTATION_ATTRIBUTE } from "./annotation.js";
import {
  type DriverRendererOptions,
  type GuideDriverConfig,
  type GuideDriverFactory,
  type GuideDriverStep,
  type GuideHintsConfig,
  type GuideHintsFactory,
  createDriverRenderer,
} from "./driver-renderer.js";

const TARGET: GuideTargetId = "nav.connections";

type DriverRecord = {
  readonly config: GuideDriverConfig;
  readonly steps: GuideDriverStep[];
  readonly popovers: HTMLElement[];
  destroyed: number;
};

/**
 * Stands in for Driver.js and reproduces the one behaviour that matters here:
 * both popover slots are filled with `innerHTML` *before* the render hook
 * runs. A fake that wrote text would prove nothing.
 */
function fakeDriver() {
  const records: DriverRecord[] = [];
  const factory: GuideDriverFactory = (config) => {
    const record: DriverRecord = {
      config,
      steps: [],
      popovers: [],
      destroyed: 0,
    };
    records.push(record);
    return {
      highlight: (step) => {
        record.steps.push(step);
        const wrapper = document.createElement("div");
        wrapper.className = `driver-popover ${step.popover.popoverClass}`;
        wrapper.setAttribute("role", "dialog");
        wrapper.setAttribute("aria-labelledby", "driver-popover-title");
        const title = document.createElement("header");
        title.className = "driver-popover-title";
        const description = document.createElement("div");
        description.className = "driver-popover-description";
        wrapper.append(title, description);
        document.body.appendChild(wrapper);
        title.innerHTML = step.popover.description;
        description.innerHTML = step.popover.description;
        step.popover.onPopoverRender({ wrapper, title, description });
        record.popovers.push(wrapper);
      },
      destroy: () => {
        record.destroyed += 1;
        for (const popover of record.popovers) popover.remove();
      },
    };
  };
  return { factory, records };
}

type HintRecord = {
  readonly config: GuideHintsConfig;
  readonly beacons: HTMLElement[];
  shown: number;
  hidden: number;
  opened: string[];
};

function fakeHints() {
  const records: HintRecord[] = [];
  const factory: GuideHintsFactory = (config) => {
    const record: HintRecord = {
      config,
      beacons: [],
      shown: 0,
      hidden: 0,
      opened: [],
    };
    records.push(record);
    return {
      show: () => {
        record.shown += 1;
        for (const spec of config.hints) {
          const beacon = document.createElement("button");
          beacon.type = "button";
          beacon.className = `driver-hint ${spec.beacon.className}`;
          document.body.appendChild(beacon);
          record.beacons.push(beacon);
        }
      },
      open: (id) => {
        record.opened.push(id);
        const spec = config.hints.find((candidate) => candidate.id === id);
        if (!spec) return;
        const wrapper = document.createElement("div");
        wrapper.className = `driver-popover ${spec.popover.popoverClass}`;
        const title = document.createElement("header");
        const description = document.createElement("div");
        description.className = "driver-popover-description";
        wrapper.append(title, description);
        document.body.appendChild(wrapper);
        description.innerHTML = spec.popover.description;
        spec.popover.onPopoverRender({ wrapper, title, description });
        record.beacons.push(wrapper);
        // The real module focuses the first focusable node it can find.
        const beacon = record.beacons[0];
        if (beacon) beacon.focus();
      },
      hide: () => {
        record.hidden += 1;
        for (const node of record.beacons) node.remove();
      },
    };
  };
  return { factory, records };
}

function mountTarget(): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = "Connections";
  document.body.appendChild(element);
  return element;
}

function options(
  overrides: Partial<DriverRendererOptions> & {
    readonly resolveElement: (id: GuideTargetId) => HTMLElement | null;
  },
): DriverRendererOptions {
  return { reducedMotion: () => true, ...overrides };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("createDriverRenderer", () => {
  it("writes the message as text even though the popover slot is an HTML sink", async () => {
    const element = mountTarget();
    const driver = fakeDriver();
    const renderer = createDriverRenderer(
      options({
        resolveElement: () => element,
        driverFactory: driver.factory,
      }),
    );

    await renderer.focus({
      target: TARGET,
      message: "<img src=x onerror=alert(1)>",
      side: "right",
    });

    const description = document.querySelector(".driver-popover-description");
    expect(description?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(description?.querySelector("img")).toBeNull();
    expect(driver.records[0]?.steps[0]?.popover.description).not.toContain("<");
  });

  it("disables Driver's animation when the person asked for reduced motion", async () => {
    const element = mountTarget();
    const reduced = fakeDriver();
    await createDriverRenderer(
      options({
        resolveElement: () => element,
        reducedMotion: () => true,
        driverFactory: reduced.factory,
      }),
    ).focus({ target: TARGET, message: "Open Connections.", side: null });

    const moving = fakeDriver();
    await createDriverRenderer(
      options({
        resolveElement: () => element,
        reducedMotion: () => false,
        driverFactory: moving.factory,
      }),
    ).focus({ target: TARGET, message: "Open Connections.", side: null });

    expect(reduced.records[0]?.config.animate).toBe(false);
    expect(reduced.records[0]?.config.smoothScroll).toBe(false);
    expect(moving.records[0]?.config.animate).toBe(true);
    expect(moving.records[0]?.config.smoothScroll).toBe(true);
  });

  it("renders nothing and records the miss when the target is not mounted", async () => {
    const driver = fakeDriver();
    const hints = fakeHints();
    const missed: GuideTargetId[] = [];
    const renderer = createDriverRenderer(
      options({
        resolveElement: () => null,
        driverFactory: driver.factory,
        hintsFactory: hints.factory,
        onMissingTarget: (target) => missed.push(target),
      }),
    );

    await expect(
      Promise.all([
        renderer.focus({ target: TARGET, message: "a", side: null }),
        renderer.hint({ target: TARGET, message: "b", side: null }),
        renderer.annotate({ target: TARGET, message: "c", side: null }),
        renderer.scroll({ target: TARGET }),
      ]),
    ).resolves.toBeDefined();

    expect(missed).toEqual([TARGET, TARGET, TARGET, TARGET]);
    expect(driver.records).toHaveLength(0);
    expect(hints.records).toHaveLength(0);
    expect(document.body.childNodes).toHaveLength(0);
  });

  it("leaves no node behind after clear()", async () => {
    const element = mountTarget();
    const driver = fakeDriver();
    const hints = fakeHints();
    const renderer = createDriverRenderer(
      options({
        resolveElement: () => element,
        driverFactory: driver.factory,
        hintsFactory: hints.factory,
      }),
    );

    await renderer.focus({ target: TARGET, message: "one", side: null });
    await renderer.hint({ target: TARGET, message: "two", side: "top" });
    await renderer.annotate({ target: TARGET, message: "three", side: "left" });
    expect(document.querySelectorAll(".driver-popover")).not.toHaveLength(0);
    expect(document.querySelectorAll(`[${ANNOTATION_ATTRIBUTE}]`)).toHaveLength(
      1,
    );

    renderer.clear();

    expect(driver.records[0]?.destroyed).toBe(1);
    expect(hints.records[0]?.hidden).toBe(1);
    expect(document.querySelectorAll("[class*='driver-']")).toHaveLength(0);
    expect(document.querySelectorAll(`[${ANNOTATION_ATTRIBUTE}]`)).toHaveLength(
      0,
    );
    expect(document.querySelectorAll(".os-guide-annotation")).toHaveLength(0);
    expect(document.body.children).toHaveLength(1);
  });

  it("replaces the previous highlight rather than stacking a second one", async () => {
    const element = mountTarget();
    const driver = fakeDriver();
    const renderer = createDriverRenderer(
      options({ resolveElement: () => element, driverFactory: driver.factory }),
    );

    await renderer.focus({ target: TARGET, message: "first", side: null });
    await renderer.focus({ target: TARGET, message: "second", side: null });

    expect(driver.records).toHaveLength(2);
    expect(driver.records[0]?.destroyed).toBe(1);
    expect(document.querySelectorAll(".driver-popover")).toHaveLength(1);
    expect(
      document.querySelector(".driver-popover-description")?.textContent,
    ).toBe("second");
  });

  it("annotates without a modal and without taking the caret", async () => {
    const element = mountTarget();
    element.focus();
    const renderer = createDriverRenderer(
      options({ resolveElement: () => element }),
    );

    await renderer.annotate({
      target: TARGET,
      message: "This list is empty until a provider is connected.",
      side: "right",
    });

    const annotation = document.querySelector(`[${ANNOTATION_ATTRIBUTE}]`);
    expect(annotation).not.toBeNull();
    expect(annotation?.getAttribute("role")).toBe("note");
    expect(annotation?.hasAttribute("aria-modal")).toBe(false);
    expect(annotation?.hasAttribute("tabindex")).toBe(false);
    expect(
      annotation?.querySelectorAll("a, button, input, select, [tabindex]"),
    ).toHaveLength(0);
    expect(document.activeElement).toBe(element);
    expect(annotation?.textContent).toBe(
      "This list is empty until a provider is connected.",
    );
  });

  it("keeps the caret where it was when a hint appears", async () => {
    const element = mountTarget();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    const hints = fakeHints();
    const renderer = createDriverRenderer(
      options({ resolveElement: () => element, hintsFactory: hints.factory }),
    );

    await renderer.hint({ target: TARGET, message: "Try here.", side: "top" });

    expect(hints.records[0]?.config.overlay).toBe(false);
    expect(hints.records[0]?.opened).toHaveLength(1);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("hands the caret to the highlighted control", async () => {
    const element = mountTarget();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    const driver = fakeDriver();
    await createDriverRenderer(
      options({ resolveElement: () => element, driverFactory: driver.factory }),
    ).focus({ target: TARGET, message: "Open Connections.", side: null });

    expect(document.activeElement).toBe(element);
    expect(driver.records[0]?.config.allowClose).toBe(true);
    expect(driver.records[0]?.config.allowKeyboardControl).toBe(true);
    expect(driver.records[0]?.config.disableActiveInteraction).toBe(false);
  });

  it("scrolls the element to the middle, honouring reduced motion", async () => {
    const element = mountTarget();
    const calls: ScrollIntoViewOptions[] = [];
    element.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => {
      if (arg === true || arg === false || arg === undefined) return;
      calls.push(arg);
    };

    await createDriverRenderer(
      options({ resolveElement: () => element, reducedMotion: () => false }),
    ).scroll({ target: TARGET });
    await createDriverRenderer(
      options({ resolveElement: () => element, reducedMotion: () => true }),
    ).scroll({ target: TARGET });

    expect(calls).toEqual([
      { block: "center", behavior: "smooth" },
      { block: "center", behavior: "auto" },
    ]);
  });

  it("does not throw when the host cannot scroll", async () => {
    const element = mountTarget();
    expect(element.scrollIntoView).toBeUndefined();
    await expect(
      createDriverRenderer(options({ resolveElement: () => element })).scroll({
        target: TARGET,
      }),
    ).resolves.toBeUndefined();
  });
});
