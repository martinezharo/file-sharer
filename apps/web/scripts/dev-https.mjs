import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A trusted HTTPS certificate for the development server, issued by Tailscale.
 *
 * The app is built on Web Crypto, service workers and the camera, and browsers
 * gate all three behind a secure context: `http://localhost` qualifies, an
 * http:// LAN or tailnet address does not. A self-signed certificate does not
 * fix that either — Chrome refuses to register a service worker behind one.
 *
 * `tailscale cert` mints a real Let's Encrypt certificate for this machine's
 * `*.ts.net` name, which every device on the tailnet already trusts, so the
 * other phone or laptop opens the URL with nothing to click through.
 */

const CERT_DIR = fileURLToPath(new URL("../.dev-certs/", import.meta.url));
// Certificates last ~90 days; renew well before the last day of a trip.
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

function tailscale(args) {
  return execFileSync("tailscale", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function stillValid(certFile, keyFile) {
  if (!existsSync(certFile) || !existsSync(keyFile)) return false;
  try {
    const validTo = Date.parse(new X509Certificate(readFileSync(certFile)).validTo);
    return validTo - Date.now() > RENEW_BEFORE_MS;
  } catch {
    return false;
  }
}

/**
 * Returns `{ domain, ip, credentials }` when this machine is on a tailnet with
 * HTTPS certificates enabled, or `null` — in which case the caller falls back
 * to plain HTTP on localhost, which is a secure context on its own.
 */
export function tailnetDevServer() {
  let status;
  try {
    status = JSON.parse(tailscale(["status", "--json"]));
  } catch {
    return null;
  }

  const domain = status?.CertDomains?.[0];
  const ip = status?.Self?.TailscaleIPs?.find((address) => !address.includes(":"));
  if (!domain || !ip) return null;

  const certFile = path.join(CERT_DIR, `${domain}.crt`);
  const keyFile = path.join(CERT_DIR, `${domain}.key`);
  if (!stillValid(certFile, keyFile)) {
    try {
      mkdirSync(CERT_DIR, { recursive: true });
      tailscale(["cert", "--cert-file", certFile, "--key-file", keyFile, domain]);
    } catch (error) {
      console.warn(
        `[dev] Tailscale HTTPS unavailable, serving over HTTP: ${error instanceof Error ? error.message.trim() : error}`,
      );
      return null;
    }
  }

  return {
    domain,
    ip,
    credentials: { cert: readFileSync(certFile), key: readFileSync(keyFile) },
  };
}
