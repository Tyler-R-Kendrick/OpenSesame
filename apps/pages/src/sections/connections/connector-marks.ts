/**
 * Brand marks for connector tiles and rows.
 *
 * Official logomarks come from the simple-icons catalog (CC0; each icon is a
 * single 24×24 path in the brand's official color). AWS and Azure publish
 * wordmarks that simple-icons no longer carries, so those render as their
 * official wordmarks. Slack, OpenAI and SendGrid use plain text labels after
 * their catalog marks were removed; other missing marks use a neutral monogram.
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
  siBitbucket,
  siBitwarden,
  siBox,
  siBuildkite,
  siCircleci,
  siClerk,
  siCloudflare,
  siCodeberg,
  siDeepgram,
  siDigitalocean,
  siDiscord,
  siDropbox,
  siElevenlabs,
  siGit,
  siGithub,
  siGitlab,
  siGnuprivacyguard,
  siGoogle,
  siGooglecloud,
  siGoogledrive,
  siGooglegemini,
  siHubspot,
  siHuggingface,
  siKeepassxc,
  siLinear,
  siMistralai,
  siNetlify,
  siNgrok,
  siObsidian,
  siPagerduty,
  siPerplexity,
  siProton,
  siRailway,
  siRender,
  siReplicate,
  siResend,
  siSentry,
  siVault,
  siVaultwarden,
  siVercel,
  siZoom,
} from "simple-icons";

export type ConnectorMarkDef = {
  /** 24×24 single-color SVG path. */
  path: string;
  /** Brand hex like "5E6AD2", or null to render in the app ink color. */
  hex: string | null;
  /** A brand wordmark used when the vendor's mark is a word rather than a glyph. */
  wordmark?: string;
  /** Relative text size for labels that need to fit within the tile. */
  wordmarkScale?: number;
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

const MARKS = {
  git: markOf(siGit),
  github: markOf(siGithub),
  gitlab: markOf(siGitlab),
  bitbucket: markOf(siBitbucket),
  codeberg: markOf(siCodeberg),
  google: markOf(siGoogle),
  "google-drive": markOf(siGoogledrive),
  "google-wallet": markOf(siGoogle),
  "google-vertex": markOf(siGooglecloud),
  "google-cloud": markOf(siGooglecloud),
  slack: { path: "", hex: null, wordmark: "Slack", wordmarkScale: 0.34 },
  linear: markOf(siLinear),
  hubspot: markOf(siHubspot),
  zoom: markOf(siZoom),
  dropbox: markOf(siDropbox),
  box: markOf(siBox),
  asana: markOf(siAsana),
  discord: markOf(siDiscord),
  sentry: markOf(siSentry),
  openai: { path: "", hex: null, wordmark: "OpenAI", wordmarkScale: 0.3 },
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
  sendgrid: { path: "", hex: null, wordmark: "SendGrid", wordmarkScale: 0.22 },
  resend: markOf(siResend),
  pagerduty: markOf(siPagerduty),
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
  "gcp-iam": markOf(siGooglecloud),
  azure: { path: "", hex: "#0078D4", wordmark: "Azure" },
  aws: { path: "", hex: "#FF9900", wordmark: "aws" },
  "aws-kms": { path: "", hex: "#FF9900", wordmark: "aws" },
  "aws-ps": { path: "", hex: "#FF9900", wordmark: "aws" },
  "aws-sts": { path: "", hex: "#FF9900", wordmark: "aws" },
  "aws-bedrock": { path: "", hex: "#FF9900", wordmark: "aws" },
  "amazon-nova": { path: "", hex: "#FF9900", wordmark: "aws" },
  "vercel-ai-gateway": markOf(siVercel),
  "cloudflare-origin-ca": markOf(siCloudflare),
  "cloudflare-ai-gateway": markOf(siCloudflare),
  "cloudflare-workers-ai": markOf(siCloudflare),
  obsidian: markOf(siObsidian),
  bitwarden: markOf(siBitwarden),
  "bitwarden-sm": markOf(siBitwarden),
  vaultwarden: markOf(siVaultwarden),
  keepass: markOf(siKeepassxc),
  "proton-pass": markOf(siProton),
  vault: markOf(siVault),
  "password-store": markOf(siGnuprivacyguard),
} satisfies Record<string, ConnectorMarkDef>;

export function connectorMark(providerId: string): ConnectorMarkDef | null {
  // `MARKS` keeps its literal keys so a typo in one is a compile error rather
  // than a silently missing logo; the lookup itself takes any provider id,
  // because the catalog is server-driven and may name a connector this build
  // has no mark for. An unknown id is a null, not a crash.
  if (!Object.hasOwn(MARKS, providerId)) return null;
  // SAFETY: `Object.hasOwn` established the key one line above.
  return MARKS[providerId as keyof typeof MARKS];
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
  "azure-key-vault-secrets",
  "azure-app-configuration",
  "azure-openai",
  "azure-access-token",
  "m365",
  "microsoft-teams",
]);

export function monogram(displayName: string): string {
  const letter = displayName.trim().charAt(0);
  return letter ? letter.toLocaleUpperCase() : "?";
}
