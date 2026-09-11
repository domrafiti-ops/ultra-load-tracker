# Logging to a Google Sheet — legacy optional path

> **Superseded.** JSONBin is now the tracker's backend — see
> [JSONBIN-SETUP.md](JSONBIN-SETUP.md). **The app no longer calls Apps Script at
> all.**
>
> **The simple way to get your history into Sheets is: press Download CSV, then
> File → Import in Google Sheets.** Name the imported tab `sessions` and every
> formula in [ANALYSIS.md](ANALYSIS.md) works unchanged — the CSV column order
> is identical to what the old script wrote. No setup, no consent screens, no
> deployment, nothing to keep working.
>
> Read on only if you want rows to land in Sheets *automatically* and are
> willing to maintain a second sync path yourself. `apps-script/Code.gs` still
> works but nothing in the app invokes it. Delete the `apps-script/` folder and
> this file if you would rather keep the repo lean.

The rest of this page documents that legacy path.

---

## Setup — about ten minutes

### 1. Create the Sheet

New Google Sheet, name it something like `Ultra Load Log`. Leave it empty; the
script creates and formats the tab itself.

### 2. Add the script

**Extensions → Apps Script.** Delete the placeholder `myFunction`, then paste
the entire contents of [`apps-script/Code.gs`](../apps-script/Code.gs). Save
(disk icon), name the project `Ultra Load Tracker`.

### 3. Deploy as a Web App

**Deploy → New deployment.**

- Click the gear next to *Select type* → **Web app**
- Description: `v1`
- **Execute as: Me**
- **Who has access: Anyone**

> "Anyone" sounds alarming and is the part people get wrong by tightening it.
> It has to be "Anyone" because the request arrives from your browser without a
> Google session attached. "Anyone with a Google account" will fail. The script
> only ever appends rows to your own sheet — it reads nothing and returns
> nothing sensitive. The protection is that the URL is unguessable. Treat it as
> unlisted: do not commit it to the repo or share it.

Click **Deploy**. Google will ask you to authorise. You will hit a screen saying
*"Google hasn't verified this app"* — this is expected for your own script.
Click **Advanced → Go to Ultra Load Tracker (unsafe)** → **Allow**.

Copy the **Web app URL**. It ends in `/exec`.

### 4. Test the deployment

Paste the `/exec` URL straight into a browser tab. You should see:

```json
{"ok":true,"sheet":"sessions","rows":0,"message":"Ultra Load Tracker endpoint is live. POST sessions here."}
```

If you see an error page instead, the deployment access setting is wrong — redo
step 3 with **Who has access: Anyone**.

### 5. Connect the tracker

Open your Pages site, go to **Profile & settings → Google Sheet sync**, paste
the URL. It saves to your browser automatically. Log a session and check the
Sheet.

---

## Why sync status says "pending" instead of "sent"

This is a deliberate honesty choice, not a bug.

Apps Script `/exec` endpoints do not return CORS headers that a browser will let
JavaScript read, and sending JSON with `Content-Type: application/json` would
trigger a CORS preflight (`OPTIONS`) that Apps Script does not answer. The
tracker therefore sends a **simple request** — `Content-Type: text/plain`, which
skips preflight — with `mode: "no-cors"`.

The consequence: the request goes through and the row lands, but the browser
hands JavaScript an *opaque* response it cannot inspect. **The page has no way
to know whether the write succeeded.** Rather than show a green tick it has not
earned, it marks the row `pending`. Check the Sheet, then click the status chip
in the log table to cycle it to `synced`.

If you would rather have real confirmation, the alternative is to open the Sheet
in a second tab and watch rows arrive. There is no way to get a readable
response from Apps Script to a static page without proxying through a server,
which reintroduces the thing GitHub Pages was chosen to avoid.

## Re-sending is safe

The script upserts on the `id` field: sending the same session twice updates the
existing row rather than duplicating it. **Push unsynced to Sheet** can be
pressed as often as you like.

## Updating the script later

If you edit `Code.gs`, you must **Deploy → Manage deployments → edit (pencil) →
Version: New version → Deploy**. Simply saving the script does *not* update the
live web app — this catches everyone once.

## Column layout

The `sessions` tab uses these columns, in this order. The analysis formulas in
[ANALYSIS.md](ANALYSIS.md) reference them by letter, so do not reorder them.

| Col | Field | Notes |
|---|---|---|
| A | `date` | |
| B | `label` | |
| C | `duration_min` | |
| D | `avg_hr` | |
| E | `distance_km` | |
| F | `ascent_m` | |
| G | `descent_m` | drives Ê linearly |
| H | `pack_kg` | |
| I | `descent_min` | needed for B̂ |
| J | `climb_min` | needed for B̂ |
| K | `cadence_spm` | |
| L | `rpe` | calibration input |
| M | `soreness` | calibration input |
| N | `ael_au` | **aerobic load** |
| O | `ecc_au` | **eccentric load** |
| P | `cyc_au` | cyclic load, blank without I and J |
| Q | `mean_descent_grade_pct` | derived |
| R | `pct_hrr` | derived |
| S | `logged_at` | ISO timestamp |
| T | `id` | upsert key |

## Optional: build the analysis tab

In the Apps Script editor, select `buildAnalysisSheet` from the function
dropdown and click **Run** once. It creates an `analysis` tab with live rolling
loads and the two calibration correlations. See [ANALYSIS.md](ANALYSIS.md) for
what to do with them.
