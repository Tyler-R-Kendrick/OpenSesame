/**
 * The target and goal the `sharing.live` capability contributes
 * (ADR 0150 as amended): the Share key beside the vault's name in the
 * shell prompt, live only while the capability is in the plan.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import type { GuideRouteDescriptor } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const LIVE_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "shell.share",
    description:
      "The Share key beside the vault's name, next to the lock: opens the sheet where a live session starts — one press shares the vault browser to browser — or, while one is running, the session itself. Routes (STUN/TURN, carriers) sit under the sheet's Advanced, collapsed.",
    role: "action",
    routes: [],
    capabilityId: "shared_sessions.live_host",
  },
];

export const LIVE_ROUTES: readonly GuideRouteDescriptor[] = [];

export const LIVE_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.live.host",
    title: "Host a live session",
    routes: ["/vault"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.live.host"',
      'say "A live session shares this vault with people who open a link and give its code. It runs browser to browser for as long as this tab stays open, with no server of its own. Values cross one at a time, on request, and you can end it for everyone."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.share" "This key, beside the vault name and the lock, opens sharing. One press on Start sharing inside begins; there are no fields to fill. Under Advanced — folded away until asked — are the choices and the routes: a relay of your own (STUN, TURN, carriers) for reaching people off this network. With none, sessions are direct only and contact nothing." side=right',
      'success "That is hosting a live session. Someone with the link and the code opens it to join; you let each person in, and a reply code goes back."',
      "end",
    ].join("\n"),
  },
];
