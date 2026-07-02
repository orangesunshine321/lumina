# Putting Pixset on the internet

Pixset only ever speaks plain HTTP on one local port. To share galleries beyond
your own machine, put one of these in front of it. All three give you HTTPS
without touching certificates yourself.

## Option A — Cloudflare Tunnel (recommended)

No port forwarding, no public IP needed, free, and works identically on a home
NAS or a cloud server. Traffic reaches Cloudflare over an outbound connection
from the container.

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
   go to **Networks → Tunnels → Create a tunnel** (Cloudflared type), name it
   `pixset`, and copy the token it shows you.
2. In your Pixset folder, add the token to `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
   ```
3. In the tunnel's **Public Hostname** tab, add your hostname (e.g.
   `photos.yourdomain.com`) with service **HTTP** → `app:3000`.
   (`app:3000` is Pixset's address *inside* the compose network — use it
   exactly, not localhost or 7373.)
4. Start Pixset with the tunnel profile:
   ```bash
   docker compose --profile tunnel up -d
   ```

Your galleries are now at `https://photos.yourdomain.com`. Cloudflare
terminates TLS and forwards the real visitor IP, which Pixset's rate limiting
uses (`TRUST_PROXY` is already set).

## Option B — Tailscale (private by default, public if you choose)

Best when galleries are for a handful of people and you'd rather not expose
anything publicly. Install [Tailscale](https://tailscale.com/download) on the
host machine, then:

```bash
# HTTPS URL reachable by devices on YOUR tailnet only (clients need Tailscale):
tailscale serve --bg 7373

# OR a genuinely public HTTPS URL through Tailscale's relay (no client needed):
tailscale funnel 7373
```

Both print the URL to share. `serve` is the safer default; `funnel` behaves
like normal public hosting. Adjust the port if you changed `PIXSET_PORT`.

## Option C — a VPS with Caddy

Rent a small VPS (any provider, ~$5/mo), install Docker, run the same
one-line installer, then put Caddy in front — see the reverse-proxy section in
the README for the 3-line Caddyfile. Point your domain's DNS at the VPS first
so Caddy can issue certificates.

## Security checklist before going public

Pixset is designed to sit on the open internet behind any of the above, but
run down this list once:

- [ ] **Set a password on any gallery you'd mind strangers seeing.** Links are
      unguessable (125-bit random), but links get forwarded — a password is
      the second lock. You can also mint a fresh link per gallery at any time
      ("Get a new link" in gallery settings) if one escapes.
- [ ] **Client downloads stay off unless you enable them** per gallery —
      browsing never exposes your full-resolution originals.
- [ ] **Use a strong admin password** (12+ characters is enforced; make it a
      real passphrase). Change it any time from the account menu; that signs
      out every other device.
- [ ] **Keep the app reachable only through your proxy/tunnel.** The default
      compose file binds to `127.0.0.1`, so nothing is exposed directly even
      if the host firewall is open. Don't remove that prefix unless a
      containerized proxy needs it.
- [ ] **Back up off the machine.** The database backs itself up daily and you
      can download a snapshot from the admin dashboard, but photo originals
      need a filesystem backup of `./data` (see the README's backup section).
- [ ] **Update occasionally** — re-run the install one-liner; it pulls the
      latest image and never touches your data.

What's already handled for you: a **first-run setup code** (shown by the
installer and in the server logs) that stops anyone from claiming the admin
account before you do — essential when the app is live on a public URL before
you've finished setup; Argon2id password hashing; per-IP and cross-IP rate
limiting with durable lockouts (using Cloudflare's real-client IP when behind
a tunnel, so it can't be bypassed by forging headers); anti-enumeration on
gallery links and logins; per-request access checks on every photo byte;
signed gallery cookies invalidated instantly on password change; a
Content-Security-Policy plus the standard security headers; a concurrency cap
on zip downloads so they can't be used to exhaust the server; the container
runs as an **unprivileged user**, not root; `noindex` on all pages; and no
third-party requests of any kind — fonts and assets are self-hosted, so client
galleries phone home to nobody.

### First-run on a public URL

If you're exposing Pixset publicly *before* creating your account (e.g. the
Cloudflare Tunnel is already live), the setup code is what protects that
window. Get it any time with:

```bash
docker compose logs app | grep "SETUP CODE"
```

Enter it on the setup screen along with your email and password. The code stops
working the moment your account is created.
