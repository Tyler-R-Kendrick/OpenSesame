/**
 * Targets, the walkthrough and the help `networking.tailnet-devices`
 * contributes (ADR 0167): the tailnet's machines under Identity › Devices,
 * live only while that capability is in the plan.
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const TAILNET_DEVICES_TARGETS: readonly GuideTargetDescriptor[] = [
  {
    id: "identity.tailnet-devices",
    description:
      "The Tailnet devices panel under Identity › Devices: every machine Tailscale reports for the tailnet, read through the daemon this page is paired with. Each row says what needs someone (waiting for approval, a key expiring, routes waiting, an update) and carries keys to approve it, open its settings (name, tags, approval, key expiry, subnet routes, exit node), expire its key and remove it. With no daemon paired, its only key pairs one.",
    role: "surface",
    routes: ["/identity"],
    capabilityId: "tailnet.devices.manage",
  },
  {
    id: "identity.tailnet-devices.add",
    description:
      "The Add a device key on the Tailnet devices panel: it opens a sheet that mints a Tailscale auth key through the daemon, with a lifetime, whether it is reusable, ephemeral or pre-approved, and its tags, then shows the key and the tailscale up command once.",
    role: "action",
    routes: ["/identity"],
    capabilityId: "tailnet.keys.manage",
  },
];

export const TAILNET_DEVICES_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "identity.tailnet.devices.manage",
    title: "Manage the tailnet's devices",
    routes: ["/identity"],
    guide: [
      "guide/1",
      'goal "identity.tailnet.devices.manage"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.devices" "The Devices tab. The tailnet\'s machines are listed first, read through the daemon on a machine on your tailnet: it holds the Tailscale credential and makes every change. Pair it once with opensesame daemon tailnet pair and this page\'s address, then open the link it prints." side=bottom',
      'wait target "identity.tailnet-devices" event=appear timeout=60000',
      'focus "identity.tailnet-devices" "Each machine Tailscale reports, waiting ones first. Its marks say what needs someone; its keys approve it, open its settings, expire its key or remove it. Every change goes through the daemon and is in the Activity list below." side=top',
      'focus "identity.tailnet-devices.add" "Add a device mints an auth key for the next machine. It is shown once, with the tailscale up command that joins with it; neither this page nor the daemon keeps it." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const TAILNET_DEVICES_HELP: readonly HelpTopic[] = [
  {
    id: "help.tailnet-devices",
    title: "How do I approve, rename or add a device on my tailnet?",
    answer:
      "Run opensesame daemon tailnet connect on a machine on your tailnet with a Tailscale OAuth client or API token, then opensesame daemon tailnet pair --origin with this page's address. Open the link it prints, and Identity › Devices lists the tailnet's machines with keys to approve, rename, tag, route, expire and remove them, and Add a device mints an auth key.",
    routes: [],
    goal: "identity.tailnet.devices.manage",
    keywords: [
      "tailscale",
      "tailnet",
      "device",
      "machine",
      "approve",
      "auth key",
      "exit node",
      "subnet",
    ],
  },
];
