import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** TLS if a cert has been issued, plain http otherwise.
 *
 * getUserMedia only runs in a secure context. `localhost` is exempt, so a bare
 * `npx vite` on this machine still works with no cert; reaching the app from
 * anything else (a phone, the laptop with the good camera) needs HTTPS or the
 * camera is simply unavailable. `make serve` issues the cert; see
 * `docker/mkcert.sh`.
 */
function devHttps(): { key: Buffer; cert: Buffer } | undefined {
  const dir = process.env.VD_CERT_DIR ?? path.join(HERE, "..", "docker", "certs");
  const key = path.join(dir, "dev-key.pem");
  const cert = path.join(dir, "dev-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export default defineConfig({
  root: ".",
  publicDir: "public",
  server: {
    // 0.0.0.0, not the default 127.0.0.1: the point of this server is to be
    // reachable from the device holding the camera.
    host: "0.0.0.0",
    port: Number(process.env.VD_PORT ?? 5199),
    // Fail loudly instead of drifting to 5200, which would leave the published
    // container port pointing at nothing.
    strictPort: true,
    https: devHttps(),
    // Vite rejects a Host header it does not recognise. Bare IPs pass, but a
    // tailscale/mDNS name does not, and the rejection reads as a blank page.
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
