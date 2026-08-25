/**
 * Brand marks for connector tiles and rows.
 *
 * Official logomarks come from the simple-icons catalog (CC0; each icon is a
 * single 24×24 path in the brand's official color). Providers whose marks are
 * not distributable (AWS, Azure) or not in the catalog fall back to a neutral
 * monogram — no fake branding.
 *
 * Marks whose official color would vanish on one of the two themes (GitHub's
 * near-black, Vercel's black) render in the app ink color instead, which is
 * how those brands present their own marks on dark surfaces.
 */

import {
  si1password,
  siAnthropic,
  siAsana,
  siAuth0,
  siBitwarden,
  siBox,
  siBuildkite,
  siCircleci,
  siClerk,
  siCloudflare,
  siDeepgram,
  siDigitalocean,
  siDiscord,
  siDropbox,
  siElevenlabs,
  siGithub,
  siGitlab,
  siGnuprivacyguard,
  siGoogle,
  siGooglecloud,
  siGooglegemini,
  siHubspot,
  siHuggingface,
  siKeepassxc,
  siLinear,
  siMistralai,
  siNetlify,
  siNgrok,
  siOpenai,
  siPagerduty,
  siPerplexity,
  siProton,
  siRailway,
  siRender,
  siReplicate,
  siResend,
  siSendgrid,
  siSentry,
  siSlack,
  siSquare,
  siStripe,
  siVault,
  siVaultwarden,
  siVercel,
  siYubico,
  siZoom,
} from "simple-icons";

export type ConnectorMarkDef = {
  /** 24×24 single-color SVG path. */
  path: string;
  /** Brand hex like "5E6AD2", or null to render in the app ink color. */
  hex: string | null;
};

/** Below this relative luminance the brand color is unreadable on the dark
 *  theme's tile, so the mark renders in the theme ink color instead. */
const MIN_LUMINANCE = 0.08;

function markOf(icon: { path: string; hex: string }): ConnectorMarkDef {
  return { path: icon.path, hex: adaptiveHex(icon.hex) };
}

export function adaptiveHex(hex: string): string | null {
  const value = Number.parseInt(hex, 16);
  if (Number.isNaN(value)) return null;
  const channel = (shift: number) => {
    const linear = ((value >> shift) & 0xff) / 255;
    return linear <= 0.03928
      ? linear / 12.92
      : ((linear + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < MIN_LUMINANCE ? null : `#${hex}`;
}

const MARKS: Record<string, ConnectorMarkDef> = {
  github: markOf(siGithub),
  gitlab: markOf(siGitlab),
  google: markOf(siGoogle),
  slack: markOf(siSlack),
  linear: markOf(siLinear),
  hubspot: markOf(siHubspot),
  zoom: markOf(siZoom),
  dropbox: markOf(siDropbox),
  box: markOf(siBox),
  asana: markOf(siAsana),
  discord: markOf(siDiscord),
  sentry: markOf(siSentry),
  stripe: markOf(siStripe),
  openai: markOf(siOpenai),
  anthropic: markOf(siAnthropic),
  mistral: markOf(siMistralai),
  perplexity: markOf(siPerplexity),
  replicate: markOf(siReplicate),
  huggingface: markOf(siHuggingface),
  elevenlabs: markOf(siElevenlabs),
  deepgram: markOf(siDeepgram),
  gemini: markOf(siGooglegemini),
  cloudflare: markOf(siCloudflare),
  vercel: markOf(siVercel),
  render: markOf(siRender),
  netlify: markOf(siNetlify),
  sendgrid: markOf(siSendgrid),
  resend: markOf(siResend),
  pagerduty: markOf(siPagerduty),
  square: markOf(siSquare),
  ngrok: markOf(siNgrok),
  clerk: markOf(siClerk),
  auth0: markOf(siAuth0),
  circleci: markOf(siCircleci),
  buildkite: markOf(siBuildkite),
  digitalocean: markOf(siDigitalocean),
  railway: markOf(siRailway),
  "1password": markOf(si1password),
  gcp: markOf(siGooglecloud),
  "gcp-kms": markOf(siGooglecloud),
  bitwarden: markOf(siBitwarden),
  "bitwarden-sm": markOf(siBitwarden),
  vaultwarden: markOf(siVaultwarden),
  keepass: markOf(siKeepassxc),
  "proton-pass": markOf(siProton),
  vault: markOf(siVault),
  "password-store": markOf(siGnuprivacyguard),
  yubikey: markOf(siYubico),
};

export function connectorMark(providerId: string): ConnectorMarkDef | null {
  return MARKS[providerId] ?? null;
}

/** Microsoft's four squares are simple enough to state as data. */
export const MICROSOFT_TILES: Array<{ x: number; y: number; fill: string }> = [
  { x: 1, y: 1, fill: "#F25022" },
  { x: 13, y: 1, fill: "#7FBA00" },
  { x: 1, y: 13, fill: "#00A4EF" },
  { x: 13, y: 13, fill: "#FFB900" },
];

export const MICROSOFT_PROVIDER_IDS = new Set([
  "microsoft",
  "azure-kms",
  "azure-sm",
  "azure-ac",
  "azure-openai",
]);

export function monogram(displayName: string): string {
  const letter = displayName.trim().charAt(0);
  return letter ? letter.toLocaleUpperCase() : "?";
}
