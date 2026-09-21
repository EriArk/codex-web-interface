import type { HubConfig } from "@codex-web/shared";
import { previewFrameSources } from "./previews.js";

export function webSecurity(config: HubConfig) {
  return {
    originAgentCluster: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: previewFrameSources(config.hub.publicBaseUrl),
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: config.hub.secureCookies ? [] : null,
      },
    },
  };
}
