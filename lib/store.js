/*!
 * store.js — persistence for the Two-Channel Ultra Load Tracker.
 *
 * JSONBin.io is the source of truth; localStorage is an offline cache and
 * write queue. Pure logic (schema, merge, size, CSV) is separated from I/O so
 * it can be tested under Node without network.
 *
 * DESIGN DECISION 1 — store inputs, never derived values.
 * Only what you measured goes in the bin. AeL, Ê and B̂ are recomputed from
 * lib/load-model.js every time they are displayed or exported. Two consequences:
 *   a. Re-fitting k_m or your descent step length retroactively corrects the
 *      entire history instead of leaving stale numbers frozen in storage.
 *   b. Records stay small, which matters because of DESIGN DECISION 2.
 *
 * DESIGN DECISION 2 — a compact wire format.
 * JSONBin's free tier rejects any bin over 100 KB. With verbose keys a session
 * costs ~294 bytes, giving only ~350 sessions of headroom (about 16 months at
 * five sessions a week). Short keys plus epoch-second timestamps bring that to
 * ~180 bytes and roughly double the capacity. The app always works with
 * readable field names; packing happens only at the storage boundary, and the
 * key map below is the single definition of the wire format.
 *
 * VERIFIED API FACTS (jsonbin.io docs, fetched 2026-09-11):
 *   root            https://api.jsonbin.io/v3
 *   read            GET  /b/<BIN_ID>/latest
 *   update          PUT  /b/<BIN_ID>        (Content-Type: application/json)
 *   auth            X-Access-Key  (needs Bins Read + Bins Update permissions)
 *   versioning      X-Bin-Versioning: true  — up to 1000 versions retained
 *   response shape  { record: {...}, metadata: {...} }
 *   CORS            enabled on all endpoints, so responses are readable
 *   free-tier cap   records over 100 KB are rejected on write
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Store = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA = 2;
  var LS_KEY = "ultra-load-tracker.v2";
  var API_ROOT = "https://api.jsonbin.io/v3";
  var SIZE_LIMIT = 100 * 1024;          // free-tier hard ceiling, verified
  var SIZE_WARN = 0.80;

  // ---- wire format: the single definition of what is stored and how --------
  // verbose (used everywhere in the app)  ->  short (used only in storage)
  var SESSION_MAP = {
    id: "i", date: "d", label: "n", durationMin: "t", avgHr: "h",
    distanceKm: "k", ascentM: "u", descentM: "w", packKg: "p",
    descentMin: "dm", climbMin: "cm", cadenceSpm: "c",
    rpe: "r", soreness: "s", editedAt: "e", deletedAt: "x"
  };
  var PROFILE_MAP = {
    massKg: "m", male: "g", hrMax: "hx", hrRest: "hn",
    descentStepLengthM: "sl", kMuscle: "km", kBone: "kb"
  };
  // Timestamps persist as epoch SECONDS, not ISO strings: 10 characters
  // instead of 24, and numeric comparison in merge is safer than string.
  var TIME_FIELDS = ["editedAt", "deletedAt"];

  var SESSION_FIELDS = Object.keys(SESSION_MAP);
  var PROFILE_FIELDS = Object.keys(PROFILE_MAP);

  function invert(map) {
    var out = {};
    Object.keys(map).forEach(function (k) { out[map[k]] = k; });
    return out;
  }
  var SESSION_UNMAP = invert(SESSION_MAP);
  var PROFILE_UNMAP = invert(PROFILE_MAP);

  // ---------------------------------------------------------------- schema ---

  function emptyDoc() {
    return { schema: SCHEMA, rev: 0, updatedAt: now(), profile: {}, sessions: [] };
  }
  function now() { return Math.floor(Date.now() / 1000); }

  function toEpoch(v) {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v === "number") return Math.floor(v > 1e11 ? v / 1000 : v);
    var t = Date.parse(v);
    return isNaN(t) ? undefined : Math.floor(t / 1000);
  }
  function toISO(sec) {
    return typeof sec === "number" && isFinite(sec)
      ? new Date(sec * 1000).toISOString() : "";
  }

  function keep(v) { return v !== undefined && v !== null && v !== ""; }

  /**
   * Bring any document into canonical in-memory form: verbose keys, numeric
   * timestamps, derived values and unknown keys removed. Accepts either wire
   * or verbose input, so it doubles as the deserialiser. Idempotent.
   */
  function normalise(doc) {
    var d = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
    return {
      schema: SCHEMA,
      rev: typeof d.rev === "number" ? d.rev : 0,
      updatedAt: toEpoch(d.updatedAt) || now(),
      profile: readFields(d.profile, PROFILE_FIELDS, PROFILE_UNMAP),
      sessions: (Array.isArray(d.sessions) ? d.sessions : [])
        .map(function (s) { return readFields(s, SESSION_FIELDS, SESSION_UNMAP); })
        .filter(function (s) { return !!s.id; })
    };
  }

  /** Read a record that may use either verbose or short keys. */
  function readFields(src, fields, unmap) {
    var s = src && typeof src === "object" ? src : {};
    var verbose = {};
    Object.keys(s).forEach(function (k) {
      var name = unmap[k] !== undefined ? unmap[k] : k;
      if (fields.indexOf(name) >= 0 && keep(s[k])) verbose[name] = s[k];
    });
    TIME_FIELDS.forEach(function (t) {
      if (verbose[t] !== undefined) {
        var e = toEpoch(verbose[t]);
        if (e === undefined) delete verbose[t]; else verbose[t] = e;
      }
    });
    return verbose;
  }

  /** Verbose -> wire. */
  function pack(doc) {
    var d = normalise(doc);
    return {
      v: SCHEMA, rev: d.rev, ts: d.updatedAt,
      profile: mapKeys(d.profile, PROFILE_MAP),
      sessions: d.sessions.map(function (s) { return mapKeys(s, SESSION_MAP); })
    };
  }
  function mapKeys(obj, map) {
    var out = {};
    Object.keys(map).forEach(function (k) { if (keep(obj[k])) out[map[k]] = obj[k]; });
    return out;
  }

  /** Wire -> verbose. Tolerates the pre-compaction shape too. */
  function unpack(wire) {
    var w = wire && typeof wire === "object" ? wire : {};
    return normalise({
      rev: w.rev,
      updatedAt: w.ts !== undefined ? w.ts : w.updatedAt,
      profile: w.profile,
      sessions: w.sessions
    });
  }

  function newId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  /** Sessions to show or export: tombstones removed, newest first. */
  function liveSessions(doc) {
    return (doc.sessions || [])
      .filter(function (s) { return !s.deletedAt; })
      .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  }

  // ----------------------------------------------------------------- merge ---

  /**
   * Merge two documents. Needed because the bin is written as a whole
   * document, so a naive PUT from a phone would clobber a laptop's edits.
   *
   * Rules:
   *   - sessions are unioned by id
   *   - for the same id, the newer editedAt wins (numeric compare)
   *   - deletions are tombstones, so a delete on one device is not resurrected
   *     by a union with a device that still holds the row
   *   - profile comes from whichever document has the higher rev
   *   - result rev is max(rev) + 1
   * Order-independent: merge(a,b) and merge(b,a) agree on every session.
   */
  function mergeDocs(a, b) {
    var A = normalise(a), B = normalise(b);
    var byId = {};
    function absorb(list) {
      list.forEach(function (s) {
        var prev = byId[s.id];
        if (!prev) { byId[s.id] = s; return; }
        var ts = s.editedAt || 0, pts = prev.editedAt || 0;
        if (ts > pts) byId[s.id] = s;
      });
    }
    absorb(A.sessions);
    absorb(B.sessions);

    var winner = B.rev > A.rev ? B : A;
    var profile = Object.keys(winner.profile).length ? winner.profile
                : (Object.keys(A.profile).length ? A.profile : B.profile);
    return {
      schema: SCHEMA,
      rev: Math.max(A.rev, B.rev) + 1,
      updatedAt: now(),
      profile: profile,
      sessions: Object.keys(byId).map(function (k) { return byId[k]; })
    };
  }

  // ------------------------------------------------------------------ size ---

  function serialise(doc) { return JSON.stringify(pack(doc)); }

  function byteLength(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str).length;
    return Buffer.byteLength(str, "utf8");
  }

  function sizeInfo(doc) {
    var bytes = byteLength(serialise(doc));
    var d = normalise(doc);
    var stored = d.sessions.length;               // tombstones occupy space too
    var live = liveSessions(d).length;
    var perSession = stored > 0 ? bytes / stored : 0;
    return {
      bytes: bytes, limit: SIZE_LIMIT, pct: bytes / SIZE_LIMIT,
      warn: bytes >= SIZE_LIMIT * SIZE_WARN, over: bytes > SIZE_LIMIT,
      sessions: live, stored: stored, bytesPerSession: perSession,
      sessionsRemaining: perSession > 0
        ? Math.max(Math.floor((SIZE_LIMIT - bytes) / perSession), 0) : null
    };
  }

  /** Drop tombstones and sessions before a cutoff date. Returns a new doc. */
  function archiveBefore(doc, cutoffDate) {
    var d = normalise(doc);
    d.sessions = d.sessions.filter(function (s) {
      return !s.deletedAt && s.date >= cutoffDate;
    });
    d.rev = d.rev + 1;
    d.updatedAt = now();
    return d;
  }

  // ------------------------------------------------------------------- csv ---

  var CSV_HEADERS = ["date", "label", "duration_min", "avg_hr", "distance_km", "ascent_m",
    "descent_m", "pack_kg", "descent_min", "climb_min", "cadence_spm", "rpe", "soreness",
    "ael_au", "ecc_au", "cyc_au", "mean_descent_grade_pct", "pct_hrr", "edited_at", "id"];

  function csvCell(v) {
    if (v === undefined || v === null) return "";
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function r1(n) { return typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : ""; }

  /**
   * Full history as CSV, oldest first. Derived columns are recomputed here from
   * the current profile, so an export always reflects the model as configured
   * now. `evaluate` is injected (LoadModel.evaluateSession) to keep this file
   * independent of the model.
   */
  function toCSV(doc, evaluate) {
    var d = normalise(doc);
    var rows = liveSessions(d).slice().reverse().map(function (s) {
      var r = evaluate ? evaluate(s, d.profile) : {};
      return [s.date, s.label, s.durationMin, s.avgHr, s.distanceKm, s.ascentM,
        s.descentM, s.packKg || 0, s.descentMin || "", s.climbMin || "",
        s.cadenceSpm || "", s.rpe == null ? "" : s.rpe,
        s.soreness == null ? "" : s.soreness,
        r1(r.aeL), r1(r.eccentric), r.cyclic == null ? "" : r1(r.cyclic),
        r1(r.meanDescentGrade * 100), r1(r.reserveFraction * 100),
        toISO(s.editedAt), s.id].map(csvCell).join(",");
    });
    return [CSV_HEADERS.join(",")].concat(rows).join("\n");
  }

  /** Weekly rollup — the historical reference view. Weeks start Monday. */
  function weeklyRollup(doc, evaluate) {
    var d = normalise(doc), buckets = {};
    liveSessions(d).forEach(function (s) {
      var wk = mondayOf(s.date);
      if (!buckets[wk]) {
        buckets[wk] = { week: wk, sessions: 0, aeL: 0, ecc: 0, cyc: 0, cycCount: 0,
                        durationMin: 0, distanceKm: 0, ascentM: 0, descentM: 0,
                        rpeSum: 0, rpeN: 0, soreSum: 0, soreN: 0 };
      }
      var b = buckets[wk], r = evaluate ? evaluate(s, d.profile) : {};
      b.sessions++;
      b.aeL += r.aeL || 0;
      b.ecc += r.eccentric || 0;
      if (r.cyclic != null) { b.cyc += r.cyclic; b.cycCount++; }
      b.durationMin += s.durationMin || 0;
      b.distanceKm += s.distanceKm || 0;
      b.ascentM += s.ascentM || 0;
      b.descentM += s.descentM || 0;
      if (s.rpe != null) { b.rpeSum += s.rpe; b.rpeN++; }
      if (s.soreness != null) { b.soreSum += s.soreness; b.soreN++; }
    });
    return Object.keys(buckets).sort().reverse().map(function (k) {
      var b = buckets[k];
      b.meanRpe = b.rpeN ? b.rpeSum / b.rpeN : null;
      b.meanSoreness = b.soreN ? b.soreSum / b.soreN : null;
      b.divergence = b.aeL > 0 ? b.ecc / b.aeL : null;
      return b;
    });
  }

  function mondayOf(isoDate) {
    var dt = new Date(isoDate + "T12:00:00Z");
    var dow = (dt.getUTCDay() + 6) % 7;           // Monday = 0
    dt.setUTCDate(dt.getUTCDate() - dow);
    return dt.toISOString().slice(0, 10);
  }

  /** Pearson r, or null when there is not enough spread or sample. */
  function correlate(pairs) {
    var n = pairs.length;
    if (n < 3) return null;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += pairs[i][0]; my += pairs[i][1]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = pairs[i][0] - mx, dy = pairs[i][1] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  // ------------------------------------------------------------ local cache ---

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return { doc: unpack(o.doc), config: o.config || {}, dirty: !!o.dirty };
    } catch (e) { return null; }
  }
  function saveLocal(doc, config, dirty) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        doc: pack(doc), config: config || {}, dirty: !!dirty
      }));
      return true;
    } catch (e) { return false; }
  }

  // -------------------------------------------------------------- jsonbin ---

  function headers(config, forWrite) {
    var h = { "X-Access-Key": config.accessKey };
    if (forWrite) {
      h["Content-Type"] = "application/json";
      h["X-Bin-Versioning"] = "true";        // up to 1000 recoverable versions
    } else {
      h["X-Bin-Meta"] = "false";             // return the record alone
    }
    return h;
  }

  function configured(config) {
    return !!(config && config.binId && config.accessKey);
  }

  function remoteRead(config) {
    if (!configured(config)) {
      return Promise.reject(err("not-configured", "Bin ID and Access Key are required."));
    }
    return fetch(API_ROOT + "/b/" + encodeURIComponent(config.binId) + "/latest", {
      method: "GET", headers: headers(config, false)
    }).then(readBody).then(function (body) {
      // X-Bin-Meta:false returns the record directly; tolerate either shape.
      return unpack(body && body.record ? body.record : body);
    });
  }

  function remoteWrite(config, doc) {
    if (!configured(config)) {
      return Promise.reject(err("not-configured", "Bin ID and Access Key are required."));
    }
    var payload = serialise(doc);
    var size = byteLength(payload);
    if (size > SIZE_LIMIT) {
      return Promise.reject(err("too-large",
        "Log is " + Math.round(size / 1024) + " KB and JSONBin's free tier rejects " +
        "anything over 100 KB. Export CSV, then archive older sessions."));
    }
    return fetch(API_ROOT + "/b/" + encodeURIComponent(config.binId), {
      method: "PUT", headers: headers(config, true), body: payload
    }).then(readBody).then(function (body) {
      return unpack(body && body.record ? body.record : pack(doc));
    });
  }

  /**
   * Read-before-write. Costs one extra request per save and is worth it: the
   * bin holds a whole document, so without this a save from one device would
   * silently discard edits made on another.
   */
  function syncPush(config, localDoc) {
    return remoteRead(config).then(function (remote) {
      var merged = mergeDocs(localDoc, remote);
      return remoteWrite(config, merged).then(function () { return merged; });
    }, function (e) {
      if (e && (e.code === "not-found" || e.code === "empty")) {
        var seeded = mergeDocs(localDoc, emptyDoc());
        return remoteWrite(config, seeded).then(function () { return seeded; });
      }
      throw e;
    });
  }

  function readBody(res) {
    return res.text().then(function (txt) {
      var parsed = null;
      try { parsed = txt ? JSON.parse(txt) : null; } catch (e) { /* error page, not JSON */ }
      if (!res.ok) {
        var msg = (parsed && (parsed.message || parsed.error)) || txt || ("HTTP " + res.status);
        throw err(codeFor(res.status, msg), msg, res.status);
      }
      if (parsed === null) throw err("empty", "Bin returned no content.");
      return parsed;
    });
  }

  function codeFor(status, msg) {
    var m = String(msg || "").toLowerCase();
    if (m.indexOf("requests exhausted") >= 0) return "quota";
    if (m.indexOf("100kb") >= 0) return "too-large";
    if (status === 401 || status === 403) {
      return m.indexOf("permission") >= 0 ? "no-permission" : "bad-key";
    }
    if (status === 404) return "not-found";
    if (status === 429) return "rate-limited";
    return "error";
  }

  function err(code, message, status) {
    var e = new Error(message || code);
    e.code = code;
    if (status) e.status = status;
    return e;
  }

  /** Actionable guidance per failure code. */
  function explain(e) {
    switch (e && e.code) {
      case "not-configured": return "Add your Bin ID and Access Key in Sync settings.";
      case "bad-key":        return "Access Key rejected. Check you copied the Access Key, not the Master Key.";
      case "no-permission":  return "That Access Key lacks a permission. Grant it both Bins Read and Bins Update.";
      case "not-found":      return "Bin ID not found on this account. Check the ID.";
      case "quota":          return "JSONBin requests exhausted. Your log is safe locally — export CSV.";
      case "too-large":      return e.message;
      case "rate-limited":   return "Rate limited. Wait a moment and press Sync again.";
      case "empty":          return "Bin is empty — press Sync to seed it with your local log.";
      default:               return (e && e.message) || "Sync failed. Your log is still saved locally.";
    }
  }

  return {
    SCHEMA: SCHEMA, LS_KEY: LS_KEY, API_ROOT: API_ROOT,
    SIZE_LIMIT: SIZE_LIMIT, CSV_HEADERS: CSV_HEADERS,
    SESSION_MAP: SESSION_MAP, PROFILE_MAP: PROFILE_MAP,
    SESSION_FIELDS: SESSION_FIELDS, PROFILE_FIELDS: PROFILE_FIELDS,
    emptyDoc: emptyDoc, normalise: normalise, pack: pack, unpack: unpack,
    newId: newId, now: now, toISO: toISO, toEpoch: toEpoch,
    liveSessions: liveSessions, mergeDocs: mergeDocs,
    serialise: serialise, sizeInfo: sizeInfo, byteLength: byteLength,
    archiveBefore: archiveBefore,
    toCSV: toCSV, weeklyRollup: weeklyRollup, mondayOf: mondayOf, correlate: correlate,
    loadLocal: loadLocal, saveLocal: saveLocal,
    configured: configured, remoteRead: remoteRead, remoteWrite: remoteWrite,
    syncPush: syncPush, explain: explain
  };
});
