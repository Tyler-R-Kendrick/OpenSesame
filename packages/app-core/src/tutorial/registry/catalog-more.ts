import { SETUP_TARGETS } from "./setup-catalog.js";
import type { GuideTargetDescriptor } from "./targets.js";

export const GUIDE_TARGETS_MORE: readonly GuideTargetDescriptor[] = [
  ...SETUP_TARGETS,
  {
    id: "settings.tailnet-sync",
    description:
      "The Tailnet sync panel under Vaults, while Networking is on: pair this vault with a drive on the tailnet (the pair key opens a sheet where the code goes), see whether it is in step, sync now, or stop. The drive holds only the sealed vault.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.drive.sync",
  },
  {
    id: "settings.live-session",
    description:
      "The Live session panel: share the whole vault or chosen items with people who open a link (and, for an invite, give its code), for up to eight hours, while this tab stays open. Each person sends a request code — by hand, or through a carrier the routes name — the owner lets them in, and a reply code goes back; the two browsers then connect. Values cross one at a time, on request, and the owner can end it for everyone.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "shared_sessions.live_host",
  },
  {
    id: "settings.live-routes",
    description:
      "The Routes panel: optional ways a live session reaches people off this network. Addresses where this device is reachable through a tunnel (Tailscale, WireGuard, Pangolin, Cloudflare WARP), STUN and TURN servers, relay only, and carriers that pass the pairing codes (Nostr, MQTT, NATS, ntfy, this browser's tabs). With none, sessions are direct only and contact nothing. Written to settings/live/transport.json, sealed in the vault.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "shared_sessions.live_host",
  },
  {
    id: "settings.item-types",
    description:
      "Switches built-in vault item types on or off, one switch per type: switching one on downloads and installs it, and nothing of it is in the app until then. A search field narrows the list; a type the vault already holds items of stays on and shows its count. Types a person wrote sit beneath, and a key opens the marketplaces, git repositories read for more types. Types are JSON manifests, not code paths.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "vault.item_types.install",
  },
  {
    id: "settings.install",
    description:
      "Installs this app on the device as a PWA, so it is available without a browser chrome.",
    role: "ceremony",
    routes: ["/settings"],
    capabilityId: "app.install",
  },
  {
    id: "vault.export",
    description:
      "Opens the export sheet in the vault's path strip: one encrypted backup file of the sealed vault body plus its key-wrapping header, opened again with the master password, for moving to another device.",
    role: "ceremony",
    routes: ["/vault"],
    capabilityId: "vault.export",
  },
];
