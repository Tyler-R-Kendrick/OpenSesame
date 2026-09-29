/**
 * Targets and walkthroughs the runtime-installed plugin capabilities
 * contribute (ADR 0150 §7): each plugin's tile inside its Settings ›
 * Capabilities section, live only while that capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goals.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const SURROGATE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.surrogate-credentials",
    description:
      "The surrogate proxy under Surrogate credentials: whether the paired daemon has it installed, its switch there, and its recent tripwires by event, time and subject. It is installed at a terminal, never from this page.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "plugins.surrogate_proxy.switch",
  },
];

export const SURROGATE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.surrogate-credentials",
    title: "Switch the surrogate proxy on or off",
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.surrogate-credentials"',
      'say "The surrogate proxy lets a tool hold a stand-in instead of a credential. It is a separate program installed on the machine that runs the daemon, and it stays off until it is switched on."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.surrogate-credentials" "Its mark says whether it is installed and running. The key beside it switches it on the paired daemon; the list under it is what it refused." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const AUTOFILL_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.browser-autofill",
    description:
      "The autofill extension under Browser autofill: whether the paired daemon has it recorded as installed, and its switch there. The extension is installed separately, never from this page.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "plugins.browser_autofill.switch",
  },
];

export const AUTOFILL_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.browser-autofill",
    title: "Switch the autofill extension on or off",
    routes: ["/settings"],
    guide: [
      "guide/1",
      'goal "settings.browser-autofill"',
      'say "The autofill extension fills a login field from its own window, by reference. It is installed separately and stays off until it is switched on."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.browser-autofill" "Its mark says whether it is installed and running. The key beside it switches it on the paired daemon." side=bottom',
      "end",
    ].join("\n"),
  },
];
