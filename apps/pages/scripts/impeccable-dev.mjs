/** Keep the local design helper out of production and ordinary dev sessions. */
export function impeccableDevHtml(html, serving, enabled) {
  // The upstream injector also edits meta CSP. Never ship that allowance.
  const cleanHtml = html
    .replaceAll(" http://localhost:8400", "")
    .replace(/\sdata-impeccable-csp-original="[^"]*"/g, "");
  if (serving && enabled) {
    const withPrefs = cleanHtml.replace(
      /<!-- impeccable-live-start -->/,
      `<!-- impeccable-live-start -->\n<style id="impeccable-pick-floor">/* Impeccable rejects targets under 20×20px. */label,.hint,.note,.xcard__name,.xcard__kind,.road__name,.road__kind,.door__lede,.unlock__brand p{min-height:1.25rem}</style>\n<script>(function(){try{localStorage.setItem("impeccable-live-interaction",JSON.stringify({pickActive:false,insertActive:false}));}catch(e){}})();</script>`,
    );
    return withPrefs
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
