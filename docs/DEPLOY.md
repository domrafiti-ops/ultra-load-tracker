# Deploying to GitHub Pages

This is a static site — plain HTML, CSS and JavaScript with no build step and no
dependencies. GitHub Pages serves it as-is.

Two routes below. **Route A needs no git and no terminal.** Use it for the first
pass; switch to Route B when you want version history from your machine.

---

## Route A — browser only

1. Go to <https://github.com/new>.
2. Name it `ultra-load-tracker`. Set it **Public** (Pages on private repos needs
   a paid plan). Do **not** tick "Add a README" — this folder already has one.
3. On the empty repo page, click **uploading an existing file**.
4. Drag the *contents* of the `ultra-load-tracker` folder in — that is
   `index.html`, `model.html`, `README.md`, and the `assets`, `lib`, `tests`,
   `docs`, `apps-script` folders. Drag the folders themselves, not a zip.
   > Make sure `index.html` lands at the top level of the repo, not inside a
   > nested `ultra-load-tracker/` folder. If it nests, Pages will serve a
   > directory listing instead of the app.
5. Commit straight to `main`.
6. **Settings → Pages**. Under *Build and deployment*, set Source to
   **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
7. Wait 1–2 minutes. Your site is at:

   ```
   https://<your-username>.github.io/ultra-load-tracker/
   ```

That URL works on your phone. Add it to your home screen and it behaves like an
app.

---

## Route B — git command line

From inside the `ultra-load-tracker` folder:

```bash
git init
git add .
git commit -m "Two-channel ultra load tracker: model, logger, tests"
git branch -M main
git remote add origin https://github.com/<your-username>/ultra-load-tracker.git
git push -u origin main
```

Then do step 6 above. Subsequent updates are `git add . && git commit -m "..." && git push`.

---

## Naming note

If you name the repo `<your-username>.github.io` instead, the site serves from
the root: `https://<your-username>.github.io/`. Everything here uses **relative
paths**, so it works either way with no edits.

## Checking it worked

Once Pages is live, open these three:

| Page | What it should show |
|---|---|
| `/` | The Load Log, with an example session pre-filled and live numbers |
| `/model.html` | The methodology, with a Minetti curve drawn and a segment table computing |
| `/tests/index.html` | **44 passed, 0 failed** in green |

If the tests page shows failures, something got mangled in upload — re-upload
`lib/load-model.js`.

If pages load but are unstyled, `assets/styles.css` did not upload. If the
numbers show as `—`, `lib/load-model.js` did not upload.

## What GitHub Pages cannot do

Pages is static hosting. There is no server, so the site cannot:

- run any code outside the visitor's browser
- **hold a secret** — anything committed to this repo is public the moment you
  push it

That second point shapes the whole storage design. The tracker uses JSONBin for
history, and the key it needs is pasted in at runtime and kept in your browser's
local storage — **never committed**. `.gitignore` covers the obvious mistakes,
but the rule is simply: do not put your Access Key in a file.

Scope that key to **Bins Read + Bins Update** and never use your Master Key. The
reasoning and the residual risk are set out in
[JSONBIN-SETUP.md](JSONBIN-SETUP.md).

## Storage on Pages, in order

1. **JSONBin** — the source of truth once configured. Survives a cleared cache
   and follows you between devices.
2. **localStorage** — offline cache and write queue, scoped to the exact origin
   `https://<username>.github.io`. Per-device and per-browser. Cleared with site
   data. Private windows start empty and forget on close.
3. **CSV / JSON export** — the permanent archive. Nothing else is durable in the
   "I still have this in five years" sense.

Run local-only for the first week if you like; the app works fully without a
bin, and adding one later pushes your existing local log up on the first sync.
