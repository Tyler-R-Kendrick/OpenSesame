/**
 * Linear's documented OAuth application manifest URL.
 *
 * The create form accepts repeated URL parameters. This is only a prefilled
 * registration link: Linear still creates the application, and the person
 * still copies its client ID into the separate advanced OAuth form.
 */
export function linearApplicationManifestUrl(input: {
  redirectUri: string;
  appUrl: string;
}): string {
  const redirect = new URL(input.redirectUri);
  const app = new URL(input.appUrl);
  const url = new URL("https://linear.app/settings/api/applications/new");
  const params = url.searchParams;
  params.set("distribution", "private");
  params.set(
    "display.description",
    "Connect OpenSesame to your Linear workspace with a user-authorized OAuth app.",
  );
  params.set("developer.name", "OpenSesame");
  params.set("oauth.client_name", "OpenSesame");
  params.set("oauth.client_uri", app.href);
  params.append("oauth.redirect_uris", redirect.href);
  params.set("oauth.grant_types", "authorization_code");
  return url.href;
}
