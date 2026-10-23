import { isString } from "@opensesame/os-domain";
/** Issuer-prefixed API keys: a parser, a synthetic generator, and no provider call. */
import type { FieldValues } from "@opensesame/vault-item-types";
import type { Random } from "./random.js";
import type { ItemFormat } from "./types.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function text(values: FieldValues, id: string): string {
  const value = values[id];
  return isString(value) ? value : "";
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

type ApiKeySpec = {
  id: string;
  label: string;
  service: string;
  header: string;
  specificity: number;
  pattern: RegExp;
  generate: (random: Random) => string;
};

const API_KEYS: readonly ApiKeySpec[] = [
  {
    id: "supabase-pat",
    label: "Supabase personal access token",
    service: "Supabase",
    header: "Authorization",
    specificity: 100,
    pattern: /^sbp_(?:v\d+_)?[0-9a-f]{40}$/u,
    generate: (random) => `sbp_${random.hex(40)}`,
  },
  {
    id: "supabase-secret",
    label: "Supabase secret key",
    service: "Supabase",
    header: "apikey",
    specificity: 99,
    pattern: /^sb_secret_[A-Za-z0-9_-]{32,}$/u,
    generate: (random) => `sb_secret_${random.string(ALNUM, 40)}`,
  },
  {
    id: "github-token",
    label: "GitHub token",
    service: "GitHub",
    header: "Authorization",
    specificity: 98,
    pattern:
      /^(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,255})$/u,
    generate: (random) => `ghp_${random.string(ALNUM, 36)}`,
  },
  {
    id: "gitlab-token",
    label: "GitLab personal access token",
    service: "GitLab",
    header: "PRIVATE-TOKEN",
    specificity: 97,
    pattern: /^glpat-[A-Za-z0-9_-]{20,}$/u,
    generate: (random) => `glpat-${random.string(ALNUM, 20)}`,
  },
  {
    id: "aws-access-key",
    label: "AWS access key ID",
    service: "AWS",
    header: "Authorization",
    specificity: 96,
    pattern: /^(?:AKIA|ASIA)[A-Z0-9]{16}$/u,
    generate: (random) =>
      `AKIA${random.string("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16)}`,
  },
  {
    id: "slack-token",
    label: "Slack token",
    service: "Slack",
    header: "Authorization",
    specificity: 95,
    pattern: /^xox[abposr]-[A-Za-z0-9-]{10,}$/u,
    generate: (random) =>
      `xoxb-${random.digits(12)}-${random.string(ALNUM, 24)}`,
  },
  {
    id: "stripe-key",
    label: "Stripe secret key",
    service: "Stripe",
    header: "Authorization",
    specificity: 94,
    pattern: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}$/u,
    generate: (random) => `sk_test_${random.string(ALNUM, 24)}`,
  },
  {
    id: "anthropic-key",
    label: "Anthropic API key",
    service: "Anthropic",
    header: "x-api-key",
    specificity: 93,
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/u,
    generate: (random) => `sk-ant-api03-${random.string(`${ALNUM}_-`, 40)}`,
  },
  {
    id: "openai-key",
    label: "OpenAI API key",
    service: "OpenAI",
    header: "Authorization",
    specificity: 92,
    pattern: /^sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}$/u,
    generate: (random) => `sk-proj-${random.string(`${ALNUM}_-`, 48)}`,
  },
  {
    id: "google-api-key",
    label: "Google API key",
    service: "Google",
    header: "x-goog-api-key",
    specificity: 91,
    pattern: /^AIza[0-9A-Za-z_-]{35}$/u,
    generate: (random) => `AIza${random.string(`${ALNUM}_-`, 35)}`,
  },
  {
    id: "npm-token",
    label: "npm access token",
    service: "npm",
    header: "Authorization",
    specificity: 90,
    pattern: /^npm_[A-Za-z0-9]{36}$/u,
    generate: (random) => `npm_${random.string(ALNUM, 36)}`,
  },
  {
    id: "hugging-face-token",
    label: "Hugging Face token",
    service: "Hugging Face",
    header: "Authorization",
    specificity: 89,
    pattern: /^hf_[A-Za-z0-9]{34,}$/u,
    generate: (random) => `hf_${random.string(ALNUM, 34)}`,
  },
  {
    id: "replicate-token",
    label: "Replicate token",
    service: "Replicate",
    header: "Authorization",
    specificity: 88,
    pattern: /^r8_[A-Za-z0-9]{32,}$/u,
    generate: (random) => `r8_${random.string(ALNUM, 37)}`,
  },
  {
    id: "groq-key",
    label: "Groq API key",
    service: "Groq",
    header: "Authorization",
    specificity: 87,
    pattern: /^gsk_[A-Za-z0-9]{40,}$/u,
    generate: (random) => `gsk_${random.string(ALNUM, 52)}`,
  },
  {
    id: "perplexity-key",
    label: "Perplexity API key",
    service: "Perplexity",
    header: "Authorization",
    specificity: 86,
    pattern: /^pplx-[A-Za-z0-9]{32,}$/u,
    generate: (random) => `pplx-${random.string(ALNUM, 32)}`,
  },
  {
    id: "xai-key",
    label: "xAI API key",
    service: "xAI",
    header: "Authorization",
    specificity: 85,
    pattern: /^xai-[A-Za-z0-9]{32,}$/u,
    generate: (random) => `xai-${random.string(ALNUM, 64)}`,
  },
  {
    id: "linear-key",
    label: "Linear API key",
    service: "Linear",
    header: "Authorization",
    specificity: 84,
    pattern: /^lin_api_[A-Za-z0-9]{40,}$/u,
    generate: (random) => `lin_api_${random.string(ALNUM, 40)}`,
  },
  {
    id: "notion-token",
    label: "Notion token",
    service: "Notion",
    header: "Authorization",
    specificity: 83,
    pattern: /^(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{46})$/u,
    generate: (random) => `ntn_${random.string(ALNUM, 46)}`,
  },
  {
    id: "airtable-token",
    label: "Airtable personal access token",
    service: "Airtable",
    header: "Authorization",
    specificity: 82,
    pattern: /^pat[A-Za-z0-9]{14}\.[a-f0-9]{64}$/u,
    generate: (random) => `pat${random.string(ALNUM, 14)}.${random.hex(64)}`,
  },
  {
    id: "figma-token",
    label: "Figma personal access token",
    service: "Figma",
    header: "X-Figma-Token",
    specificity: 81,
    pattern: /^figd_[A-Za-z0-9_-]{40,}$/u,
    generate: (random) => `figd_${random.string(`${ALNUM}_-`, 43)}`,
  },
  {
    id: "shopify-token",
    label: "Shopify access token",
    service: "Shopify",
    header: "X-Shopify-Access-Token",
    specificity: 80,
    pattern: /^shp(?:at|ss)_[a-f0-9]{32}$/u,
    generate: (random) => `shpat_${random.hex(32)}`,
  },
  {
    id: "digitalocean-token",
    label: "DigitalOcean token",
    service: "DigitalOcean",
    header: "Authorization",
    specificity: 79,
    pattern: /^dop_v1_[a-f0-9]{64}$/u,
    generate: (random) => `dop_v1_${random.hex(64)}`,
  },
  {
    id: "sendgrid-key",
    label: "SendGrid API key",
    service: "SendGrid",
    header: "Authorization",
    specificity: 78,
    pattern: /^SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u,
    generate: (random) =>
      `SG.${random.string(`${ALNUM}_-`, 22)}.${random.string(`${ALNUM}_-`, 43)}`,
  },
  {
    id: "mailgun-key",
    label: "Mailgun API key",
    service: "Mailgun",
    header: "Authorization",
    specificity: 77,
    pattern: /^key-[a-f0-9]{32}$/u,
    generate: (random) => `key-${random.hex(32)}`,
  },
  {
    id: "pypi-token",
    label: "PyPI API token",
    service: "PyPI",
    header: "Authorization",
    specificity: 76,
    pattern: /^pypi-[A-Za-z0-9_-]{40,}$/u,
    generate: (random) => `pypi-${random.string(`${ALNUM}_-`, 60)}`,
  },
  {
    id: "sentry-token",
    label: "Sentry token",
    service: "Sentry",
    header: "Authorization",
    specificity: 75,
    pattern: /^sntrys_[A-Za-z0-9_-]{40,}$/u,
    generate: (random) => `sntrys_${random.string(`${ALNUM}_-`, 64)}`,
  },
  {
    id: "twilio-api-key",
    label: "Twilio API key SID",
    service: "Twilio",
    header: "Authorization",
    specificity: 74,
    pattern: /^SK[a-f0-9]{32}$/u,
    generate: (random) => `SK${random.hex(32)}`,
  },
  {
    id: "posthog-key",
    label: "PostHog personal API key",
    service: "PostHog",
    header: "Authorization",
    specificity: 73,
    pattern: /^phx_[A-Za-z0-9]{40,}$/u,
    generate: (random) => `phx_${random.string(ALNUM, 40)}`,
  },
  {
    id: "planetscale-token",
    label: "PlanetScale token",
    service: "PlanetScale",
    header: "Authorization",
    specificity: 72,
    pattern: /^pscale_tkn_[A-Za-z0-9_-]{32,}$/u,
    generate: (random) => `pscale_tkn_${random.string(`${ALNUM}_-`, 43)}`,
  },
  {
    id: "resend-key",
    label: "Resend API key",
    service: "Resend",
    header: "Authorization",
    specificity: 71,
    pattern: /^re_[A-Za-z0-9]{32}$/u,
    generate: (random) => `re_${random.string(ALNUM, 32)}`,
  },
  {
    id: "doppler-token",
    label: "Doppler token",
    service: "Doppler",
    header: "Authorization",
    specificity: 70,
    pattern: /^dp\.pt\.[A-Za-z0-9]{40,}$/u,
    generate: (random) => `dp.pt.${random.string(ALNUM, 43)}`,
  },
  {
    id: "onepassword-token",
    label: "1Password service account token",
    service: "1Password",
    header: "Authorization",
    specificity: 69,
    pattern: /^ops_[A-Za-z0-9_-]{40,}$/u,
    generate: (random) => `ops_${random.string(`${ALNUM}_-`, 43)}`,
  },
  {
    id: "hashicorp-vault-token",
    label: "HashiCorp Vault token",
    service: "HashiCorp Vault",
    header: "X-Vault-Token",
    specificity: 68,
    pattern: /^hvs\.[A-Za-z0-9_-]{20,}$/u,
    generate: (random) => `hvs.${random.string(`${ALNUM}_-`, 40)}`,
  },
  {
    id: "pulumi-token",
    label: "Pulumi access token",
    service: "Pulumi",
    header: "Authorization",
    specificity: 67,
    pattern: /^pul-[a-f0-9]{40}$/u,
    generate: (random) => `pul-${random.hex(40)}`,
  },
  {
    id: "generic-api-key",
    label: "Synthetic API key",
    service: "OpenSesame test service",
    header: "Authorization",
    specificity: 20,
    pattern: /^opensesame_test_[A-Za-z0-9_-]{32,}$/u,
    generate: (random) => `opensesame_test_${random.string(`${ALNUM}_-`, 32)}`,
  },
] as const;

export function apiKeyFormats(typeId: string): ItemFormat[] {
  return API_KEYS.map((spec) => ({
    id: `${typeId}:${spec.id}`,
    typeId,
    label: spec.label,
    specificity: spec.specificity,
    parse(value): FieldValues | null {
      const key = value.trim();
      if (!spec.pattern.test(key)) return null;
      return typeId === "api-credential"
        ? { service: spec.service, apiKey: key }
        : { apiKey: key, header: spec.header };
    },
    generate({ random }): FieldValues {
      const apiKey = spec.generate(random);
      return typeId === "api-credential"
        ? { service: spec.service, apiKey }
        : { apiKey, header: spec.header };
    },
    canonical: (values) => trimToNull(text(values, "apiKey")),
  }));
}
