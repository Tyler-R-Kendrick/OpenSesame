/**
 * Targets and the walkthrough `sharing.trusted-contacts` contributes
 * (ADR 0187): the Settings › Trusted contacts category and its three panels,
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
    id: "circle.new",
    description:
      "The Start a circle key on the Circles panel: opens a sheet that names a circle and says what it protects, makes the invitation to hand to each contact, and sets the rule and the clocks for the people who answer.",
    role: "action",
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
    id: "guarding.accept",
    description:
      "The Accept an invitation key on the Guarding panel: opens a sheet that reads an invitation, shows the circle and the owner's key to check with them, and has your security key or keys answer it.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "quorum.guardian.hold",
  },
  {
    id: "guarding.take",
    description:
      "The Take what an owner sent key on the Guarding panel: opens a sheet that takes the welcome an owner hands you, with your share of a recovery key when the circle has one, or a new policy for a circle you already hold.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "quorum.guardian.hold",
  },
  {
    id: "guarding.answer",
    description:
      "The Answer a request key on the Guarding panel: opens a sheet that reads a request against the policy you hold, shows the sentence you would be approving, and approves it or releases your share once the delay has passed.",
    role: "action",
    routes: ["/settings"],
    capabilityId: "quorum.request.approve",
  },
  {
    id: "settings.trusted-contacts-recovery",
    description:
      "The Recovery panel: each recovery you have started from a circle's recovery file, with how many contacts have approved it and how many have released their share.",
    role: "surface",
    routes: ["/settings"],
    capabilityId: "quorum.recover",
  },
  {
    id: "recovery.start",
    description:
      "The Start a recovery key on the Recovery panel: opens a sheet that reads a circle's recovery file, names this device, and sends a request for the circle's contacts to approve and then release their shares.",
    role: "action",
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
  {
    id: "settings.trusted-contacts.guardian",
    title: "Agree to hold a share for someone",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.guardian"',
      'say "A guardian agrees to hold one share of someone\'s recovery key, or only a seat at their approvals. You agree with your own security key, and later you approve a request or release your share the same way, after a delay that gives the owner time to object. What passes between you is a packet you hand over yourself."',
      'navigate "/settings/trusted-contacts"',
      'wait route "/settings/trusted-contacts" timeout=15000',
      'scroll "settings.trusted-contacts-guarding"',
      'focus "settings.trusted-contacts-guarding" "Guarding lists the circles you hold a part of, whose they are, and where each one stands." side=top',
      'focus "guarding.accept" "Accept an invitation reads one from an owner, shows you the circle and the owner\'s key to check with them another way, and has your security key answer. You hand the answer back." side=bottom',
      'focus "guarding.take" "Take what an owner sent keeps the welcome they hand back, with your share when the circle has one, and gives you a receipt to return. A new policy for a circle you hold goes in the same place." side=bottom',
      'focus "guarding.answer" "Answer a request reads a request against the policy you hold and shows the sentence you would be approving. Approve with your key, and after the delay release your share." side=bottom',
      'success "That is a guardian: agree, take what you are sent, and answer requests. Nothing goes to a service."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.trusted-contacts.recovery",
    title: "Recover what a circle protects",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.trusted-contacts.recovery"',
      'say "Getting something back from a circle takes the circle\'s recovery file and enough of its contacts. Each approves with their own security key, and after the delay the owner set, releases their share the same way."',
      'navigate "/settings/trusted-contacts"',
      'wait route "/settings/trusted-contacts" timeout=15000',
      'scroll "settings.trusted-contacts-recovery"',
      'focus "settings.trusted-contacts-recovery" "Recoveries you have started are listed here with how many contacts have approved and how many have released. Open one to hand its request to the contacts and add what they send back." side=top',
      'focus "recovery.start" "Start a recovery reads the circle\'s recovery file, names this device and sends the request. When enough shares are released the result is a file to save, or items to put in this vault." side=bottom',
      'success "That is a recovery: a file, a request, approvals, releases, and what the circle protected."',
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
      'say "A circle is the people you trust to approve a request, or to hold one share of a recovery key. You make it here: name it, say what it protects, hand an invitation to each person, and set how many of them it takes."',
      'navigate "/settings/trusted-contacts"',
      'wait route "/settings/trusted-contacts" timeout=15000',
      'focus "settings.trusted-contacts-circles" "Your circles are listed here, each with its rule, how many contacts it has and where it stands. Open one to invite more people, change it, ask its contacts to approve a share, or retire it." side=top',
      'focus "circle.new" "Start a circle names it, makes the invitation and sets the rule and the clocks. Each contact answers with their own security key, and you hand each of them a packet." side=bottom',
      'success "That is a circle: an invitation, the people who answer it, a rule, and a packet for each. Nothing goes to a service."',
      "end",
    ].join("\n"),
  },
];
