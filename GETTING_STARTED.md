# Pixset for photographers — plain-English setup

You don't need to be technical to run Pixset. It's about ten minutes, and
after that it's just a website you open in your browser.

## What you need

- Your own computer that stays on when clients are browsing (a desktop, a
  Mac mini, a NAS…), or a small rented cloud server.
- About 10 minutes.

## Step 1 — Install Docker Desktop (one time)

Docker is the thing that runs Pixset. Download it here and install it like
any other app: https://www.docker.com/products/docker-desktop/

Open it once after installing and leave it running (it can start
automatically with your computer — allow that when it asks).

## Step 2 — Install Pixset (one command)

Open the **Terminal** app (on a Mac: press Cmd+Space, type "Terminal", press
Enter). Paste this line and press Enter:

```
curl -fsSL https://raw.githubusercontent.com/orangesunshine321/pixset/main/install.sh | bash
```

Wait for it to say **"Pixset is running."** That's the whole install.

## Step 3 — Create your account

The installer prints a **setup code** and an address (normally
`http://localhost:7373`). Open the address in your browser, enter that setup
code, and create your admin account. **Bookmark that address** — it's your
studio's door. Use a long password you don't use anywhere else.

(The setup code makes sure only you — the person who can see the installer's
output — can create the account. You'll only need it this once.)

## Step 4 — Use it

1. Click **New gallery**, name it after the shoot.
2. Drag your exported JPEGs onto the upload box.
3. Copy the gallery link and send it to your client (set a gallery password
   first in Settings if the shoot is sensitive).
4. They tap hearts on their favorites — no account needed on their end.
5. Back in the gallery, **Copy Lightroom list**, paste into Lightroom
   Classic's Library Filter (Text → Filename → Any), and every pick selects
   itself.

## Sharing with clients who aren't on your Wi-Fi

Out of the box, the address only works on your own computer/network. To send
links that work anywhere, follow **DEPLOYMENT.md** — the Cloudflare Tunnel
option is free and doesn't require touching your router. If a technical
friend set Pixset up for you, ask them to do that part; it's a one-time step.

## Updating, later

Paste the same install command from Step 2 again. It updates Pixset without
touching your photos or galleries.

## If something looks broken

1. Is Docker Desktop running? (Whale icon in your menu bar / system tray.)
   Start it, wait a minute, try the bookmark again.
2. Still stuck? Restart your computer, make sure Docker starts, try again.
3. Still stuck? Re-run the install command from Step 2 — it repairs the
   install and never deletes your photos.

## The one rule: back up the `pixset/data` folder

Everything — photos, galleries, your clients' picks — lives in one folder
called `data` inside the `pixset` folder the installer created. Copy it to an
external drive now and then (or let Time Machine / your backup tool include
it), and you can never really lose anything.
