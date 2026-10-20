/**
 * Targets and the walkthrough `sharing.trusted-contacts` contributes
 * (ADR 0187): the Trusted contacts section of Settings › Security and its
 * Circles panel, live only while that capability is in the plan.
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
    id: "/settings/security",
    title: "Settings — security: trusted contacts and circles",
  },
];

export const TRUSTED_CONTACTS_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.trusted-contacts",
    description:
      "The Trusted contacts section of Settings › Security: the circles you keep, kept on this device and handed between people as packets.",
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
    id: "circle.new",
    description:
      "The Start a circle key on the Circles panel: opens a sheet that names a circle and says what it protects, makes the invitation to hand to each contact, and sets the rule and the clocks for the people who answer.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "quorum.circle.manage",
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
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.trusted-contacts" "A circle is the people you trust to approve a request, with a delay that gives you time to object. Each answers with their own security key, and what passes between you is a packet you hand over yourself. Nothing goes to a service." side=bottom',
      'focus "settings.trusted-contacts-circles" "Circles are the ones you own. Each is a rule, the contacts in it and where it stands." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.trusted-contacts.owner",
    title: "Make a circle and invite its contacts",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.owner"',
      'say "A circle is the people you trust to approve a request. You make it here: name it, hand an invitation to each person, and set how many of them it takes."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.trusted-contacts-circles" "Your circles are listed here, each with its rule, how many contacts it has and where it stands. Open one to invite more people, change it, ask its contacts to approve a share, or retire it." side=top',
      'focus "circle.new" "Start a circle names it, makes the invitation and sets the rule and the clocks. Each contact answers with their own security key, and you hand each of them a packet." side=bottom',
      'success "That is a circle: an invitation, the people who answer it, a rule, and a packet for each. Nothing goes to a service."',
      "end",
    ].join("\n"),
  },
];
