import https from "node:https";
import tls from "node:tls";

export function createUpstreamAgent(): https.Agent {
  if (typeof tls.getCACertificates !== "function") {
    console.warn(
      "[request-logger] This Node.js version cannot load the system certificate store. " +
        "Upgrade to Node.js 22.15+ or set NODE_EXTRA_CA_CERTS to your organization's PEM CA bundle before starting the logger."
    );
    return new https.Agent({ keepAlive: true, rejectUnauthorized: true });
  }

  // Keep bundled and NODE_EXTRA_CA_CERTS roots when adding OS-trusted CAs.
  const ca = [
    ...new Set([
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("system"),
    ]),
  ];
  return new https.Agent({ keepAlive: true, rejectUnauthorized: true, ca });
}
