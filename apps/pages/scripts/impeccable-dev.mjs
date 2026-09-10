/** Keep the local design helper out of production and ordinary dev sessions. */
export function impeccableDevHtml(html, serving, enabled) {
  // The upstream injector also edits meta CSP. Never ship that allowance.
  const cleanHtml = html
    .replaceAll(" http://localhost:8400", "")
    .replace(/\sdata-impeccable-csp-original="[^"]*"/g, "");
  if (serving && enabled) {
    return cleanHtml
      .replace("script-src 'self'", "script-src 'self' http://localhost:8400")
      .replace(
        /<script\s+src="http:\/\/localhost:8400\//g,
        '<script crossorigin="anonymous" src="http://localhost:8400/',
      );
  }
  return cleanHtml
    .replace(
      /<!-- impeccable-live-start -->[\s\S]*?<!-- impeccable-live-end -->/g,
      "",
    )
    .replace(
      /<script\b[^>]*\bsrc=["']http:\/\/localhost:8400\/[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
      "",
    );
}
