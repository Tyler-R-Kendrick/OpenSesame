import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { LocalGithubApp } from "./github-app-local.js";

export type Integration = {
  id: string;
  key: string;
  providerId: string;
  displayName: string;
  source: string;
  enabled: boolean;
  configured: boolean;
  scopes: string[];
  /** Public GitHub App page when this is a tenant App integration. */
  githubAppHtmlUrl: string | null;
};

export function toIntegration(value: BoundaryValue): Integration {
  const raw = overlapCast(value);
  const html = isString(raw.github_app_html_url)
    ? raw.github_app_html_url.trim()
    : "";
  return {
    id: String(raw.id ?? ""),
    key: String(raw.key ?? ""),
    providerId: String(raw.provider_id ?? ""),
    displayName: String(raw.display_name ?? ""),
    source: String(raw.source ?? ""),
    enabled: Boolean(raw.enabled),
    configured: Boolean(raw.configured),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : [],
    githubAppHtmlUrl: html.startsWith("https://github.com/apps/") ? html : null,
  };
}

export function integrationFromLocal(app: LocalGithubApp): Integration {
  return {
    id: app.id,
    key: app.key,
    providerId: "github",
    displayName: app.displayName,
    source: "github-app",
    enabled: true,
    configured: true,
    scopes: [],
    githubAppHtmlUrl: app.htmlUrl,
  };
}

