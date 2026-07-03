// Copy-paste config the operator runs on their HOST (the app can't apply any of
// it from inside its container). `host` is the public hostname; `port` is the
// loopback port the compose stack publishes (LUMINA_PORT, default 7373).

const DEFAULT_PORT = 7373;

function hostOrPlaceholder(host: string): string {
  return host.trim() || "gallery.example.com";
}

/** Cloudflare Tunnel, manual (dashboard) route — just the .env line + command,
 * since the hostname→service mapping is done in the Cloudflare dashboard. */
export function cloudflareManualSteps(): { env: string; command: string } {
  return {
    env: "CLOUDFLARE_TUNNEL_TOKEN=<paste-your-tunnel-token>",
    command: "docker compose --profile tunnel up -d",
  };
}

/** Tailscale Funnel — run on the host that publishes the app on loopback. */
export function tailscaleSnippet(port = DEFAULT_PORT): string {
  return [
    "# One-time: enable HTTPS + Funnel for your tailnet in the admin console.",
    "# Then, on the host running Lumina:",
    `tailscale funnel --bg ${port}`,
    "",
    "# Your gallery is now at https://<machine>.<tailnet>.ts.net",
    "# (tailnet-only, no public Funnel? use:  tailscale serve --bg " + port + " )",
  ].join("\n");
}

/** Caddy reverse proxy (host-installed) — automatic HTTPS. */
export function caddySnippet(host: string, port = DEFAULT_PORT): string {
  return [`${hostOrPlaceholder(host)} {`, `\treverse_proxy 127.0.0.1:${port}`, "}"].join("\n");
}

/** Nginx server block (host-installed) — pair with certbot for TLS. */
export function nginxSnippet(host: string, port = DEFAULT_PORT): string {
  const h = hostOrPlaceholder(host);
  return [
    "server {",
    "    listen 443 ssl;",
    `    server_name ${h};`,
    "",
    `    # ssl_certificate     /etc/letsencrypt/live/${h}/fullchain.pem;`,
    `    # ssl_certificate_key /etc/letsencrypt/live/${h}/privkey.pem;`,
    "",
    "    # Large gallery zips stream chunked — don't buffer them.",
    "    proxy_buffering off;",
    "    client_max_body_size 0;",
    "",
    "    location / {",
    `        proxy_pass http://127.0.0.1:${port};`,
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        # Strip any inbound CF-Connecting-IP so it can't be spoofed here.",
    "        proxy_set_header CF-Connecting-IP \"\";",
    "        proxy_read_timeout 300s;",
    "    }",
    "}",
  ].join("\n");
}
