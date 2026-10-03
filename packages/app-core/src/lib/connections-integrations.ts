import type { LocalGithubApp } from "./github-app-local.js";

/** A GitHub App registered from this browser, as the pages read it. */
export type Integration = {
  id: string;
  key: string;
  providerId: string;
  displayName: string;
  source: string;
  enabled: boolean;
  configured: boolean;
  scopes: string[];
  /** Public GitHub App page for the App registered here. */
  githubAppHtmlUrl: string | null;
};

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
