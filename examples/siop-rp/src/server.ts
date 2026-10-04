/**
 * Entry point: read the environment, optionally read the Pages deployment's
 * metadata document, and listen.
 *
 *   OPENSESAME_PAGES_BASE   https://<owner>.github.io/<repo>  (the deployment)
 *   SIOP_RP_CLIENT_ID       local_<uuid>, as the person registered it
 *   SIOP_RP_REDIRECT_URI    the exact registered callback
 *   SIOP_RP_DISCOVER=1      fetch siop-metadata.json first and refuse to start
 *                           if it does not name the issuer you configured
 *   SIOP_RP_ALLOW_LOOPBACK_HTTP=1   development only: accept http://127.0.0.1
 *                           and http://localhost URLs (never needed in production)
 */
import { fetchSiopMetadata } from "@opensesame/siop-v2";
import { createSiopRpApp } from "./app.js";
import { issuerOf, loadSiopRpConfig } from "./config.js";

const config = loadSiopRpConfig();

const accepted = config.discover
  ? await fetchSiopMetadata({
      fetch,
      expectedIssuer: issuerOf(config),
      metadataUrl: config.metadataUrl,
      allowMirror: config.metadataMirror,
      allowLoopbackHttp: config.allowLoopbackHttp,
    })
  : undefined;

const app = createSiopRpApp(config, {
  authorizationEndpoint: accepted?.authorizationEndpoint,
});

app.listen(config.port, config.host, () => {
  console.log(`SIOP relying party listening on http://${config.listen}`);
});
