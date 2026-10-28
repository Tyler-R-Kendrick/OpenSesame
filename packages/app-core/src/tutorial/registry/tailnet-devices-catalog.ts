/**
 * Targets, the walkthrough and the help `networking.tailnet-devices`
 * contributes (ADR 0169): the tailnet's machines under Identity › Devices,
 * live only while that capability is in the plan.
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";
import { type GuideRouteDescriptor, TAILNET_DEVICES_ROUTE } from "./routes.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const TAILNET_DEVICES_ROUTES: readonly GuideRouteDescriptor[] = [
  { id: TAILNET_DEVICES_ROUTE, title: "Identity — Tailnet devices" },
];

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
    id: "identity.tailnet-devices.commands",
    description:
      "The Tailnet devices heading and its available controls. An eligible unpaired page can offer pairing; a connected daemon with a manage pairing offers Add a device. Other pairings may offer reload and forget instead.",
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
      'navigate "/identity/devices/tailnet"',
      'wait route "/identity/devices/tailnet" timeout=15000',
      'say "The Tailnet devices record is under Identity › Devices. Connect the daemon to a tailnet. On a dedicated or loopback deployment, run opensesame daemon tailnet pair --origin with this page\'s address and open the link it prints. The daemon holds the Tailscale credential and makes every change."',
      'wait target "identity.tailnet-devices" event=appear timeout=60000',
      'focus "identity.tailnet-devices" "Once the daemon is paired and connected, the machines it reports appear here, waiting ones first. Marks say what needs someone; the keys your pairing allows approve a device, open its settings, expire its key or remove it. Changes go through the daemon and appear in Activity." side=top',
      'wait target "identity.tailnet-devices.commands" event=appear timeout=60000',
      'focus "identity.tailnet-devices.commands" "Available controls depend on the pairing and connection. An eligible page can pair with a daemon. With a connected daemon and manage access, Add a device mints an auth key shown once with the tailscale up command; neither this page nor the daemon keeps it." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "identity.tailnet.devices.add",
    title: "Add a device to the tailnet",
    routes: ["/identity"],
    libraryOnly: true,
    requires: ["tailnet.devices.add-available"],
    guide: [
      "guide/1",
      'goal "identity.tailnet.devices.add"',
      'focus "identity.tailnet-devices.add" "Add a device opens a sheet to mint an auth key. Choose its lifetime and permissions there; the key and tailscale up command are shown once." side=bottom',
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
