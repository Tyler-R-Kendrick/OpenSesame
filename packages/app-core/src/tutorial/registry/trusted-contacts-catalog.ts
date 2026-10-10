/**
 * Targets and the walkthrough `sharing.trusted-contacts` contributes
 * (ADR 0186): the Settings › Trusted contacts category and its three panels,
 * live only while that capability is in the plan.
 *
 * The panels hold lists, and a list holds only what a person's own ceremonies
 * made; a target here names a panel or the category, never a circle, a contact
 * or a request (ADR 0088). The ceremonies' own keys append their targets and
 * steps beside these as their sheets land.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const TRUSTED_CONTACTS_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/trusted-contacts",
    title:
      "Settings — trusted contacts: circles, shares you hold and recoveries",
  },
];

export const TRUSTED_CONTACTS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.trusted-contacts",
    description:
      "The Trusted contacts settings category: the circles you keep, the shares you hold for other people, and the recoveries you have asked for, all kept on this device and handed between people as packets.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
  },
  {
    id: "settings.trusted-contacts-circles",
    description:
      "The Circles panel: each circle you own is listed with its rule, such as 2 of 3, how many contacts it has and where it stands.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
  },
  {
    id: "settings.trusted-contacts-guarding",
    description:
      "The Guarding panel: each circle that has asked you to take a part in it, whether a share of a recovery key or only a seat at its approvals, with whose it is and where it stands.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "quorum.guardian.hold",
  },
  {
    id: "settings.trusted-contacts-recovery",
    description:
      "The Recovery panel: each recovery you have started from a circle's recovery file, with how many contacts have approved it and how many have released their share.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "quorum.recover",
  },
];

export const TRUSTED_CONTACTS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.trusted-contacts.circle",
    title: "Start a circle of trusted contacts",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.circle"',
      'navigate "/settings/trusted-contacts"',
      'wait route "/settings/trusted-contacts" timeout=15000',
      'focus "settings.trusted-contacts" "A circle is the people you trust to approve a request, or to hold one share of a recovery key, with a delay that gives you time to object. Each answers with their own security key, and what passes between you is a packet you hand over yourself. Nothing goes to a service." side=bottom',
      'focus "settings.trusted-contacts-circles" "Circles are the ones you own. Each is a rule, the contacts in it and where it stands." side=top',
      'scroll "settings.trusted-contacts-guarding"',
      'focus "settings.trusted-contacts-guarding" "Guarding is the other side: circles that asked you to take a part, and the requests waiting on your key." side=top',
      'focus "settings.trusted-contacts-recovery" "Recovery is for getting something back. Open a circle\'s recovery file, ask its contacts, and the result lands in the normal import." side=top',
      "end",
    ].join("\n"),
  },
];
