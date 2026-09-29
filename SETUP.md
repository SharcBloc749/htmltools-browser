# HTMLTools Browser — Full Setup Guide

Follow this top to bottom. Total time: ~15 minutes. Cost: $0, no card asked
anywhere. You need: your GitHub account, your Cloudflare account, and any
text editor (Notepad is fine).

---

## TL;DR checklist

- [ ] 1. Download `htmltools-browser.zip` (from this workspace) and unzip it
- [ ] 2. Push the folder to a new GitHub repo
- [ ] 3. Deploy `server/main.ts` on Deno Deploy → get your `*.deno.dev` URL
- [ ] 4. Paste that URL into `client/config.js`
- [ ] 5. Copy the `client/` files into your htmltools.me repo under `/browser/`
- [ ] 6. Open `https://htmltools.me/browser/` → type `example.com` → done

---

## Step 1 — Get the code onto your computer

1. In this chat's workspace/files panel, download **`htmltools-browser.zip`**.
2. Unzip it anywhere (Desktop is fine). You should see:

```
htmltools-browser/
├── client/          ← the frontend (goes on Cloudflare Pages)
│   ├── index.html
│   ├── app.js
│   ├── sw.js        ← the proxy engine
│   ├── runtime.js
│   ├── encoder.js
│   ├── rewrite.js
│   └── config.js    ← the ONLY file you'll edit
├── server/
│   └── main.ts      ← the backend (goes on Deno Deploy)
├── tests/
│   └── test.mjs
├── README.md
├── SETUP.md         ← you are reading it
├── package.json
└── LICENSE
```

---

## Step 2 — Put the code on GitHub

You do **not** need git installed — the GitHub website can upload everything.

1. Go to **github.com** → log in → click the **+** (top right) → **New repository**.
2. Name it `htmltools-browser`, set it to **Public**, click **Create repository**.
3. On the new repo page, click the link **"uploading an existing file"**.
4. Drag the **`client`**, **`server`**, and **`tests`** folders plus
   `README.md`, `SETUP.md`, `package.json`, `LICENSE` from the unzipped
   folder into the upload area. (Dragging the folders keeps the structure.)
5. Click **Commit changes**.

> Tip: don't upload the zip itself, just the loose files/folders.

---

## Step 3 — Deploy the backend (Deno Deploy, free)

1. Go to **dash.deno.com** → click **Sign in with GitHub** → authorize.
   (No card, no payment screen — the free tier is genuinely free.)
2. Click **New Project** → choose **Deploy from GitHub repository**.
3. If asked, install the Deno Deploy GitHub app and give it access to
   `htmltools-browser`.
4. Select the `htmltools-browser` repo.
5. In the settings it shows, set the **Entrypoint** to:

   ```
   server/main.ts
   ```

6. Click **Deploy** (or "Link"/"Create" — wording varies).
7. When it finishes, your backend is live at a URL like:

   ```
   https://htmltools-browser.deno.dev
   ```

8. **Test it:** open that URL in a browser tab. You should see:

   ```json
   {"service":"htmltools-proxy","ok":true,"version":"1.0.0"}
   ```

   If you see that JSON, the backend works. Keep this URL, you need it in
   the next step. (You can rename the subdomain later in project Settings.)

> No GitHub? Alternative: on dash.deno.com click **Playgrounds → New**,
> paste the entire contents of `server/main.ts`, click **Save & Deploy**.
> Same result, but the GitHub route auto-deploys when you edit later, so
> it's the better option.

---

## Step 4 — Point the frontend at your backend

1. Open `client/config.js` in a text editor (double-click → Notepad).
2. Replace the BACKEND line with **your** URL from step 3:

   ```js
   export const BACKEND = 'https://htmltools-browser.deno.dev';
   ```

3. (Optional but recommended) change `KEY` to any random gibberish — it
   scrambles the proxied URLs. Any letters/numbers, keep the quotes.
4. Save the file.

---

## Step 5 — Put the frontend on your site (Cloudflare Pages)

Since htmltools.me already deploys from GitHub, the easiest path is adding
a `/browser/` folder to that same repo:

1. Go to your **htmltools.me repo** on GitHub.
2. Click **Add file → Create new file**… actually for a folder upload it's
   easier to: **Add file → Upload files**, then drag the **contents** of
   `client/` — but first create the folder by naming the files with a
   prefix. GitHub trick: in the upload page you can also just drag a
   folder from your computer and it keeps the folder name. So: drag the
   whole **`client` folder** — GitHub will upload it as `client/...`.
   Rename it after upload: open `client`, click the pencil-ish rename via
   editing… 

   **Simpler, guaranteed way:** on your computer, rename the `client`
   folder to `browser` first. Then upload that folder. Done — no renaming
   on GitHub needed.
3. Also make sure the edited `config.js` (from step 4) is the one inside
   that `browser` folder.
4. **Commit changes**. Cloudflare Pages detects the push and redeploys
   automatically (watch the progress in your Cloudflare dashboard →
   Workers & Pages → your project → Deployments).

When it's live, visit:

```
https://htmltools.me/browser/
```

> Prefer a separate Pages project instead? Cloudflare dashboard →
> Workers & Pages → Create → Pages → Connect to Git → pick
> `htmltools-browser` → set **Root directory** to `client` → Deploy.
> You'll get a `*.pages.dev` URL, and you can add `browser.htmltools.me`
> as a custom domain in the project's Custom domains tab (one click since
> the domain is already in your Cloudflare account). Everything else in
> this guide stays the same.

---

## Step 6 — Test everything

1. Open **`https://htmltools.me/browser/`** (must be the https version —
   service workers require secure contexts).
2. You should see the status bar say **"Engine ready — type a URL and hit
   Enter."**
3. Type `example.com` → Enter. You should see Example Domain rendered
   inside the page, and the address bar should now read
   `https://example.com`.
4. Try `wikipedia.org` — should load fast and clickable links should stay
   inside the browser.
5. Search test: type `cats` in the address bar → it should search
   DuckDuckGo.

---

## Troubleshooting

**Status bar says the browser can't run here / no service worker**
You're on `http://` or inside some odd iframe. Use `https://htmltools.me/browser/`
directly in a real browser tab. (`localhost` also works for dev.)

**Pages load but say "proxy backend unreachable"**
- Open your `*.deno.dev` URL directly. No JSON? The backend isn't up —
  check dash.deno.com → your project → Logs for errors.
- JSON works? Then `config.js` has a typo (trailing slash is fine, missing
  `https://` is not). Fix, commit, wait for Pages to redeploy.

**I edited files but nothing changed**
The old service worker is cached. DevTools (F12) → Application →
Storage → **Clear site data** → reload. Do this after every config change.

**Page loads but looks broken / no images**
Check the browser console (F12). A red error naming `deno.dev` means the
backend got blocked or errored on that resource — grab the message and
we'll debug together.

**Google shows a CAPTCHA / "unusual traffic"**
Expected on any free-hosted backend (datacenter IP reputation). Not a bug
— same thing happens on GUST. Use DuckDuckGo/Bing as your default for now.

**I changed `KEY` and now pages 404**
Old pages had URLs scrambled with the old key. Clear site data (see above)
and start from the homepage.

---

## How to update things later

| You change… | What happens |
|---|---|
| Any file in the htmltools.me repo | Cloudflare Pages redeploys automatically (~30s) |
| Any file in the htmltools-browser repo | Deno Deploy restarts the backend automatically |
| `config.js` BACKEND | Instant switchover (clear site data once) |

## Getting help

When something breaks, grab these and bring them back to me:
1. The exact URL you're on
2. The red text from DevTools console (F12 → Console)
3. What your `*.deno.dev` URL shows when opened directly
