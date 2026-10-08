/**
 * Tours of the frame the app is drawn in: the sections, the statusline and,
 * on a narrow screen, the two keys that stand in for them (ADR 0163).
 *
 * The rail and the statusline are drawn only on a wide screen, and the Sections
 * key and the More key only on a narrow one, so each tour says which it is for
 * (`requires`): a tour that pointed at a control the screen does not draw would
 * point at nothing. A section a plan may leave out has its own tour, contributed
 * by the capability that draws it (`section-nav-goals.ts`).
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const SHELL_TOUR_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections",
    title: "Find your way around",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.sections"',
      'say "OpenSesame is a few sections. Each is a row in the rail on the left, and a key that begins with g jumps to it from anywhere."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "nav.vault" "Vault holds every account, passkey, card, secret and note. Press g then v from anywhere to come back to it." side=right',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "nav.settings" "Settings is a row too, opened with g then s. While you are in it the rail shows Settings alone, with a row at the top that goes back to the vault." side=right',
      'say "Access, Connections, Identity, Wallet and Activity join the rail when they are switched on in Settings › Capabilities, and each has its own tour from the moment it does."',
      'say "Press g then j to join a session somebody shared. That road stays available when this device already holds a vault."',
      'success "That is the rail. Press g and then a letter to move between sections without the pointer."',
      "end",
    ].join("\n"),
  },
  {
    id: "shell.sections.phone",
    title: "Find your way around on a phone",
    routes: [],
    libraryOnly: true,
    requires: ["shell.narrow"],
    guide: [
      "guide/1",
      'goal "shell.sections.phone"',
      'say "A narrow screen draws one section at a time and has no rail. The sections are in a drawer, behind one key at the left of the top bar."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "nav.menu" "Sections opens the drawer: Vault, Settings and every other section this device has switched on. Choosing one closes the drawer and opens that section." side=bottom',
      'say "Settings is in the drawer too, and so is Activity when it is on. The drawer is the same list the rail shows on a wide screen."',
      'success "That is the drawer. The More key at the right of the bar holds what a wide screen puts in its statusline."',
      "end",
    ].join("\n"),
  },
  {
    id: "shell.statusline",
    title: "Read the statusline",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.statusline"',
      'say "The strip along the bottom of the screen is the statusline: the Support mark, the command bar, and the bell."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.notifications" "The bell collects what needs a person: pending links, failed syncs, expiring items. Its dot says something is waiting. Press it to read the notices." side=top',
      'wait target "notifications.health" event=appear timeout=60000',
      'say "When the password health report has findings, the notices carry a Review passwords link that opens it. It appears only while there is something to review."',
      'success "That is the statusline. Support and the command bar have tours of their own."',
      "end",
    ].join("\n"),
  },
  {
    id: "shell.more",
    title: "Read the More key on a phone",
    routes: [],
    libraryOnly: true,
    requires: ["shell.narrow"],
    guide: [
      "guide/1",
      'goal "shell.more"',
      'say "A narrow screen has no statusline. What it carries is behind one key at the right of the top bar."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.connectivity" "The More key. Its dot says something needs you: a connection to set up, no network, or a notice waiting. Press it to read the notices, open Help and the keymap, and see a row for each connection and what it is doing." side=bottom',
      'success "That is the More key."',
      "end",
    ].join("\n"),
  },
];
