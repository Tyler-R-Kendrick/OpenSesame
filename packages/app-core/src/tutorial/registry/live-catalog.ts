/**
 * The target and route the `sharing.live` capability contributes
 * (ADR 0150): the Settings › Live sessions tab, live only while the
 * capability is in the plan. Its two panels' targets are core-declared
 * (`catalog-more.ts`), as every panel a capability draws is.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const LIVE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "settings.live",
    description:
      "The Live sessions settings category: host a live session from this tab, and the routes its sessions may use to reach people who are not on the same network.",
    role: "navigation",
    routes: ["/settings"],
    capabilityId: "shared_sessions.live_host",
  },
];

export const LIVE_ROUTES: readonly GuideRouteDescriptor[] = [
  {
    id: "/settings/live",
    title: "Settings — live sessions: host one, and the routes it may use",
  },
];

export const LIVE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.live.host",
    title: "Host a live session",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.live.host"',
      'say "A live session shares the whole vault, or items you choose, with people who open a link. It runs browser to browser for as long as this tab stays open, with no server of its own."',
      'navigate "/settings/live"',
      'wait route "/settings/live" timeout=15000',
      'focus "settings.live" "Live sessions is its own category. It holds the panel that hosts a session and the routes a session may use." side=bottom',
      'focus "settings.live-session" "Choose what to share, what each person may do, how they are admitted and for how long, up to eight hours. Each person sends you a request code, you let them in, and a reply code goes back. Values cross one at a time, on request, and you can end the session for everyone." side=right',
      'scroll "settings.live-routes"',
      'focus "settings.live-routes" "Routes are optional ways to reach people off this network: a tunnel address, STUN and TURN servers, relay only, and carriers that pass the pairing codes. With none, sessions are direct only and contact nothing." side=top',
      'success "That is hosting a live session. Someone with a link opens it to join."',
      "end",
    ].join("\n"),
  },
];
