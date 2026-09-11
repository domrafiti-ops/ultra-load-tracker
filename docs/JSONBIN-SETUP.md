# Sync setup — JSONBin

The tracker keeps your history in a single JSONBin bin. Every device that has
the Bin ID and Access Key sees the same log, and the app never needs a server of
its own.

**This is optional.** Without it the app works fully and stores everything in
your browser. Set it up when you want history that survives a cleared cache and
follows you from phone to laptop.

Setup is about five minutes.

---

## 1. Create the account and the bin

1. Sign up at <https://jsonbin.io>.
2. **Create Bin.** Replace the sample content with exactly this and save:

   ```json
   {"v":2,"rev":0,"ts":0,"profile":{},"sessions":[]}
   ```

   > The app can seed an empty bin itself, but starting with valid shape means
   > your first sync succeeds instead of reporting an empty bin.

3. Make sure the bin is **Private** (the default).
4. Copy the **Bin ID** from the URL or the bin header — a long hex-ish string.

## 2. Create an Access Key, not a Master Key

**Do not use your Master Key.** JSONBin's own documentation is explicit about
why: the Master Key "has default access to each API endpoint and is apt for
backend applications where your key isn't exposed", whereas the Access Key is
"better for JavaScript apps where your source is sensitive and open". This app
is the second case.

1. Go to **API Keys** in the JSONBin dashboard.
2. Create an **Access Key**.
3. Grant exactly two permissions:
   - **Bins Read**
   - **Bins Update**

   Leave Create, Delete, and everything else off. The app never needs them, and
   a key that cannot delete cannot be used to destroy your history.
4. Copy the key.

## 3. Connect

Open the tracker, go to **Sync & storage**, paste the Bin ID and the Access Key.
They save to your browser immediately. Press **Pull from bin** to confirm the
connection.

Repeat on your phone with the same two values and both devices share one log.

---

## What the key protects, and what it does not

Be clear-eyed about this. GitHub Pages is static hosting, so there is nowhere to
hide a secret. The Access Key sits in your browser's local storage and is
visible to anyone with access to your browser or its devtools.

| Risk | Status |
|---|---|
| Key committed to a public repo | **Avoided** — the app only ever reads it from local storage. Never paste it into a file you push. |
| Key can create or delete other bins | **Avoided** — scoped to Read + Update on bins only. |
| Key is readable in your own browser | **Accepted.** Unavoidable on static hosting. |
| Someone with the key reads or overwrites this log | **Accepted.** Blast radius is one training log. |

The mitigation that matters: **put nothing in this bin except training data.**
If the key leaks, the worst case is that a stranger sees how much you climbed,
or trashes the log — and JSONBin keeps up to 1000 prior versions, which the app
enables on every write, so you can restore from their dashboard.

If that trade is unacceptable, the honest alternative is not a different
static-hosting trick — it is a small server that holds the key. That is a real
step up in complexity for a personal training log.

---

## How syncing behaves

**Read-before-write on every save.** A bin holds one whole JSON document, so a
naive write from your phone would overwrite whatever your laptop had added. The
app instead reads the bin, merges, then writes. Costs one extra request per save
and removes an entire class of silent data loss.

**Merge rules** (asserted in `tests/store.test.js`):

- Sessions are unioned by id, so no device's entries are dropped.
- Editing the same session on two devices: the newer edit wins.
- Deletes are tombstones. Without them, syncing from a device that still held a
  deleted row would resurrect it.
- Merging is order-independent — the result is the same whichever side is read
  first.

**Request budget.** A free JSONBin account comes with 10,000 requests, credited
once and never expiring. The app uses one request on load and two per save
(read + write). At one session a day and a few page opens, that is roughly
1,500 a year. **The app never polls** — that is a deliberate choice to protect
this budget. Press **Pull from bin** when you want to check for changes from
another device.

**Offline.** Writes queue locally. The sync chip reads *pending changes* and
the next successful sync pushes everything.

---

## The 100 KB ceiling

JSONBin's free tier refuses to write any bin over 100 KB. This is the one hard
constraint on the design, and two decisions follow from it.

**Only inputs are stored.** AeL, Ê and B̂ never go in the bin — they are
recomputed from `lib/load-model.js` on every render. That halves record size,
and it means re-fitting `k_m` retroactively corrects the whole history instead
of leaving stale numbers frozen in storage.

**The wire format uses short keys and epoch-second timestamps.** Verbose keys
cost ~294 bytes per session, which allowed only ~350 sessions. The compact form
costs **190 bytes**, giving room for about **540 sessions** — a little over two
years at five sessions a week. The app always works with readable field names;
packing happens only at the storage boundary, and `SESSION_MAP` in
`lib/store.js` is the single definition of the format.

The **Bin size** meter turns amber at 80 % of the cap. When you get there:

1. **Download CSV** — that is your permanent archive, and it holds the full
   history with all derived columns.
2. Set a cutoff date and press **Trim log to this cutoff**.
3. Press **Sync now** to write the smaller bin.

## Troubleshooting

| Message | Cause |
|---|---|
| *Access Key rejected. Check you copied the Access Key, not the Master Key.* | Wrong key, or a typo. The most common setup mistake by a wide margin. |
| *That Access Key lacks a permission.* | Grant it both **Bins Read** and **Bins Update**. |
| *Bin ID not found on this account.* | Wrong Bin ID, or the bin belongs to a different JSONBin account. |
| *Bin is empty — press Sync to seed it.* | Fresh bin. Press **Sync now** and the app writes your local log into it. |
| *JSONBin requests exhausted.* | The 10,000 are gone. Your log is safe locally; export CSV. |
| *Over the 100 KB free-tier cap.* | See the section above. |

Every failure leaves your log intact in local storage and the CSV export
working. Sync is a convenience layer, never the only copy.

## Restoring from a backup

**Download raw JSON** gives you the exact bin contents. To restore, paste that
JSON into the bin in JSONBin's dashboard, then press **Pull from bin**. You can
also restore any of the last 1000 versions from JSONBin's own version history.
