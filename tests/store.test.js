/*
 * Assertions for store.js — schema, merge, tombstones, size budget, CSV,
 * weekly rollup. No network: only the pure logic is exercised.
 *
 * The merge tests matter most. The bin is written as a whole document, so a
 * bug here does not throw — it silently eats a session.
 *
 * Run:  node tests/store.test.js
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../lib/store.js"), require("../lib/load-model.js"));
  } else {
    root.runStoreTests = function () { return factory(root.Store, root.LoadModel); };
  }
})(typeof self !== "undefined" ? self : this, function (S, LM) {
  "use strict";

  var results = [];
  function ok(name, cond, detail, note) {
    results.push({ name: name, pass: !!cond, detail: detail || "", note: note || "" });
  }
  function eq(name, actual, expected, note) {
    ok(name, actual === expected, "got " + JSON.stringify(actual) +
       ", expected " + JSON.stringify(expected), note);
  }
  function near(name, actual, expected, tolPct, note) {
    var e = expected === 0 ? Math.abs(actual) : Math.abs((actual - expected) / expected) * 100;
    ok(name, e <= tolPct, "got " + round(actual) + ", expected " + round(expected) +
       " (" + e.toFixed(2) + "% off)", note);
  }
  function round(n) { return typeof n === "number" ? Math.round(n * 100) / 100 : n; }

  var PROFILE = {
    massKg: 70, male: true, hrMax: 188, hrRest: 46,
    descentStepLengthM: 1.05, kMuscle: 1.5, kBone: 3
  };
  function session(over) {
    var base = {
      id: "s_a", date: "2026-09-01", label: "Trail loop",
      durationMin: 120, avgHr: 145, distanceKm: 16,
      ascentM: 900, descentM: 900, packKg: 0,
      editedAt: "2026-09-01T18:00:00.000Z"
    };
    for (var k in (over || {})) base[k] = over[k];
    return base;
  }
  function docWith(sessions, rev) {
    return { schema: 1, rev: rev || 1, updatedAt: "2026-09-01T18:00:00.000Z",
             profile: PROFILE, sessions: sessions };
  }

  // ------------------------------------------------------------------------
  // 1. Schema discipline — derived values must never be persisted
  // ------------------------------------------------------------------------
  var dirty = docWith([session({ aeL: 999, eccentric: 888, cyclic: 777, junk: "x" })]);
  var clean = S.normalise(dirty);
  ok("normalise strips derived values",
    clean.sessions[0].aeL === undefined && clean.sessions[0].eccentric === undefined &&
    clean.sessions[0].cyclic === undefined,
    "aeL/eccentric/cyclic absent after normalise",
    "storing inputs only is what makes re-fitting k_m correct the whole history");
  eq("normalise strips unknown keys", clean.sessions[0].junk, undefined);
  eq("normalise keeps inputs", clean.sessions[0].distanceKm, 16);
  eq("normalise pins schema version", clean.schema, S.SCHEMA);
  ok("normalise is idempotent",
    JSON.stringify(S.normalise(clean)) === JSON.stringify(clean), "second pass is a no-op");
  eq("normalise drops sessions without an id",
    S.normalise({ sessions: [{ date: "2026-01-01" }, session()] }).sessions.length, 1);
  eq("normalise survives garbage input", S.normalise(null).sessions.length, 0);
  eq("normalise survives a string", S.normalise("nope").sessions.length, 0);
  eq("normalise survives an array", S.normalise([1, 2, 3]).sessions.length, 0);
  eq("ISO timestamps are coerced to epoch seconds",
     typeof clean.sessions[0].editedAt, "number",
     "numeric compare in merge is safer than string compare");

  // ---- wire format round-trip ----
  var wire = S.pack(docWith([session({ id: "s_a", rpe: 6, soreness: 3 })]));
  ok("wire format uses short keys",
    wire.sessions[0].i === "s_a" && wire.sessions[0].t === 120 && wire.sessions[0].k === 16,
    "i/t/k present", "SESSION_MAP is the single definition of the on-disk shape");
  ok("wire format has no verbose keys",
    wire.sessions[0].durationMin === undefined && wire.sessions[0].distanceKm === undefined,
    "verbose keys absent from storage");
  var back = S.unpack(wire);
  eq("round-trip preserves duration", back.sessions[0].durationMin, 120);
  eq("round-trip preserves label", back.sessions[0].label, "Trail loop");
  eq("round-trip preserves soreness", back.sessions[0].soreness, 3);
  eq("round-trip preserves id", back.sessions[0].id, "s_a");
  ok("round-trip is stable under a second pass",
    JSON.stringify(S.pack(S.unpack(wire))) === JSON.stringify(wire), "pack(unpack(x)) == x");
  eq("unpack tolerates verbose input too",
     S.unpack(docWith([session()])).sessions[0].durationMin, 120,
     "so an older hand-edited bin still loads");

  // ------------------------------------------------------------------------
  // 2. Merge — the correctness-critical path
  // ------------------------------------------------------------------------
  var laptop = docWith([session({ id: "s_a" }), session({ id: "s_b", date: "2026-09-02" })], 4);
  var phone  = docWith([session({ id: "s_a" }), session({ id: "s_c", date: "2026-09-03" })], 5);
  var m = S.mergeDocs(laptop, phone);
  eq("merge unions disjoint sessions", S.liveSessions(m).length, 3,
     "laptop had a+b, phone had a+c — no edit may be lost");
  eq("merge does not duplicate a shared id",
     m.sessions.filter(function (s) { return s.id === "s_a"; }).length, 1);
  eq("merge bumps rev above both", m.rev, 6);
  eq("merge takes profile from the higher rev", m.profile.massKg, 70);

  // Same id edited on both devices: newer editedAt wins
  var older = docWith([session({ id: "s_a", avgHr: 140, editedAt: "2026-09-01T10:00:00.000Z" })], 1);
  var newer = docWith([session({ id: "s_a", avgHr: 152, editedAt: "2026-09-01T20:00:00.000Z" })], 1);
  eq("merge keeps the newer edit (a then b)", S.mergeDocs(older, newer).sessions[0].avgHr, 152);
  eq("merge keeps the newer edit (b then a)", S.mergeDocs(newer, older).sessions[0].avgHr, 152,
     "merge must be order-independent");

  // Tombstones — a delete on one device must not be undone by a union
  var kept    = docWith([session({ id: "s_a", editedAt: "2026-09-01T10:00:00.000Z" })], 2);
  var deleted = docWith([session({ id: "s_a", editedAt: "2026-09-01T12:00:00.000Z",
                                   deletedAt: "2026-09-01T12:00:00.000Z" })], 3);
  var afterDel = S.mergeDocs(kept, deleted);
  eq("delete survives merge (deleted side second)", S.liveSessions(afterDel).length, 0,
     "without tombstones a stale device would resurrect the row");
  eq("delete survives merge (deleted side first)",
     S.liveSessions(S.mergeDocs(deleted, kept)).length, 0);
  eq("tombstone is retained in storage, not dropped", afterDel.sessions.length, 1);

  // Undelete: re-adding with a newer timestamp must win over the tombstone
  var undeleted = docWith([session({ id: "s_a", editedAt: "2026-09-01T14:00:00.000Z" })], 4);
  eq("a newer re-add beats the tombstone",
     S.liveSessions(S.mergeDocs(deleted, undeleted)).length, 1);

  // Merging with an empty doc must be lossless (the seed-a-new-bin path)
  eq("merge with an empty doc keeps everything",
     S.liveSessions(S.mergeDocs(laptop, S.emptyDoc())).length, 2);

  // ------------------------------------------------------------------------
  // 3. Size budget — JSONBin free tier rejects bins over 100 KB
  // ------------------------------------------------------------------------
  eq("size limit is the verified 100 KB", S.SIZE_LIMIT, 102400);

  var many = [];
  for (var i = 0; i < 200; i++) {
    many.push(session({
      id: "s_" + i,
      date: "2026-" + String(1 + (i % 12)).padStart(2, "0") + "-" + String(1 + (i % 28)).padStart(2, "0"),
      label: "Morning trail loop with a fairly long descriptive name",
      descentMin: 45, climbMin: 55, cadenceSpm: 176, rpe: 6.5, soreness: 4
    }));
  }
  var big = S.sizeInfo(docWith(many));
  ok("200 verbose sessions fit inside the cap", !big.over,
     Math.round(big.bytes / 1024 * 10) / 10 + " KB of 100 KB (" + Math.round(big.pct * 100) + "%)");
  ok("per-session cost is under 400 bytes", big.bytesPerSession < 400,
     Math.round(big.bytesPerSession) + " bytes/session");
  ok("capacity is at least 2 years at 5 sessions/week",
     big.sessions + big.sessionsRemaining >= 520,
     "headroom for ~" + (big.sessions + big.sessionsRemaining) + " sessions total",
     "5/week x 104 weeks = 520");
  ok("warn flag is off at 200 sessions", !big.warn, "warns from 80% of the cap");

  var over = [];
  for (var j = 0; j < 900; j++) {
    over.push(session({ id: "x_" + j,
      label: "Morning trail loop with a fairly long descriptive name",
      descentMin: 45, climbMin: 55, cadenceSpm: 176, rpe: 6.5, soreness: 4 }));
  }
  ok("the over-cap flag actually trips", S.sizeInfo(docWith(over)).over,
     "900 sessions exceeds 100 KB — the app must warn before this");

  // ---- archiving, the escape hatch when the cap is eventually reached ----
  var aged = docWith([
    session({ id: "old1", date: "2024-01-15" }),
    session({ id: "old2", date: "2025-06-01" }),
    session({ id: "new1", date: "2026-09-01" }),
    session({ id: "gone", date: "2026-09-02", deletedAt: "2026-09-02T00:00:00.000Z" })
  ], 7);
  var pruned = S.archiveBefore(aged, "2026-01-01");
  eq("archive keeps only sessions on/after the cutoff", pruned.sessions.length, 1);
  eq("archive keeps the right session", pruned.sessions[0].id, "new1");
  eq("archive also purges tombstones", pruned.sessions.filter(function (s) {
    return !!s.deletedAt; }).length, 0, "tombstones cost bytes once everyone has synced");
  eq("archive bumps rev so it propagates", pruned.rev, 8);
  ok("archive shrinks the document",
    S.sizeInfo(pruned).bytes < S.sizeInfo(aged).bytes,
    S.sizeInfo(aged).bytes + " -> " + S.sizeInfo(pruned).bytes + " bytes");

  // ------------------------------------------------------------------------
  // 4. CSV — derived columns recomputed at export time
  // ------------------------------------------------------------------------
  var doc = docWith([
    session({ id: "s_1", date: "2026-09-01", rpe: 6, soreness: 3 }),
    session({ id: "s_2", date: "2026-09-03", descentM: 1500, distanceKm: 20, rpe: 8, soreness: 6 }),
    session({ id: "s_3", date: "2026-09-05", deletedAt: "2026-09-05T00:00:00.000Z" })
  ], 1);
  var csv = S.toCSV(doc, LM.evaluateSession);
  var lines = csv.split("\n");
  eq("csv header count", lines[0].split(",").length, S.CSV_HEADERS.length);
  eq("csv excludes tombstoned rows", lines.length, 3, "header + 2 live sessions");
  ok("csv is oldest-first", lines[1].indexOf("2026-09-01") === 0, lines[1].slice(0, 10));
  var aelCol = S.CSV_HEADERS.indexOf("ael_au"), eccCol = S.CSV_HEADERS.indexOf("ecc_au");
  eq("csv ael_au lands in column N", aelCol + 1, 14);
  eq("csv ecc_au lands in column O", eccCol + 1, 15);
  ok("csv carries a computed eccentric value",
    parseFloat(lines[1].split(",")[eccCol]) > 0, lines[1].split(",")[eccCol] + " AU");

  // The point of storing inputs: changing k_m must move historical numbers.
  var atDefault = parseFloat(S.toCSV(doc, LM.evaluateSession).split("\n")[1].split(",")[eccCol]);
  var stiffDoc = JSON.parse(JSON.stringify(doc));
  stiffDoc.profile.kMuscle = 2.0;
  var atStiff = parseFloat(S.toCSV(stiffDoc, LM.evaluateSession).split("\n")[1].split(",")[eccCol]);
  ok("re-fitting k_m retroactively corrects history", Math.abs(atStiff - atDefault) > 1,
     "k=1.5 -> " + atDefault + " AU, k=2.0 -> " + atStiff + " AU",
     "this is only possible because derived values are not persisted");

  // Injection / delimiter safety
  var nasty = S.toCSV(docWith([session({ id: "s_x", label: 'Loop, "big" day\nsecond line' })]), LM.evaluateSession);
  ok("csv quotes commas, quotes and newlines in labels",
    nasty.indexOf('"Loop, ""big"" day') >= 0, "label correctly escaped");

  // ------------------------------------------------------------------------
  // 5. Weekly rollup — the historical reference view
  // ------------------------------------------------------------------------
  eq("monday of a Friday", S.mondayOf("2026-09-11"), "2026-09-07");
  eq("monday of a Monday is itself", S.mondayOf("2026-09-07"), "2026-09-07");
  eq("monday of a Sunday looks back", S.mondayOf("2026-09-13"), "2026-09-07");

  var weeks = S.weeklyRollup(docWith([
    session({ id: "w1", date: "2026-09-07", rpe: 6, soreness: 3 }),
    session({ id: "w2", date: "2026-09-09", rpe: 8, soreness: 5 }),
    session({ id: "w3", date: "2026-09-14", rpe: 4, soreness: 2 })
  ]), LM.evaluateSession);
  eq("rollup groups into two weeks", weeks.length, 2);
  eq("rollup is newest week first", weeks[0].week, "2026-09-14");
  eq("rollup counts sessions in the week", weeks[1].sessions, 2);
  near("rollup sums descent", weeks[1].descentM, 1800, 0.1);
  near("rollup averages RPE", weeks[1].meanRpe, 7, 0.1);
  ok("rollup computes a divergence ratio", weeks[1].divergence > 0,
     "Ê/AeL = " + round(weeks[1].divergence));

  // ------------------------------------------------------------------------
  // 6. Correlation helper
  // ------------------------------------------------------------------------
  eq("correlation needs 3 points", S.correlate([[1, 1], [2, 2]]), null);
  near("perfect positive correlation", S.correlate([[1, 1], [2, 2], [3, 3]]), 1, 0.01);
  near("perfect negative correlation", S.correlate([[1, 3], [2, 2], [3, 1]]), -1, 0.01);
  eq("zero variance returns null", S.correlate([[1, 5], [1, 5], [1, 5]]), null,
     "guards against a divide-by-zero showing up as NaN in the UI");

  // ------------------------------------------------------------------------
  // 7. Config guard and error messages
  // ------------------------------------------------------------------------
  ok("configured() rejects a missing key", !S.configured({ binId: "abc" }), "binId alone");
  ok("configured() rejects a missing bin", !S.configured({ accessKey: "k" }), "key alone");
  ok("configured() accepts both", S.configured({ binId: "abc", accessKey: "k" }), "");
  ["not-configured", "bad-key", "no-permission", "not-found", "quota", "rate-limited", "empty"]
    .forEach(function (code) {
      var msg = S.explain({ code: code });
      ok("error '" + code + "' has actionable guidance", msg && msg.length > 20 && msg !== code, msg);
    });
  ok("master-key confusion is called out by name",
    S.explain({ code: "bad-key" }).toLowerCase().indexOf("master key") >= 0,
    "the single most common setup mistake");

  var failed = results.filter(function (r) { return !r.pass; });
  return { results: results, passed: results.length - failed.length, failed: failed.length };
});

if (typeof module === "object" && module.exports && require.main === module) {
  var out = module.exports;
  out.results.forEach(function (r) {
    var line = (r.pass ? "  PASS  " : "  FAIL  ") + r.name;
    while (line.length < 54) line += " ";
    console.log(line + " " + r.detail + (r.note ? "   // " + r.note : ""));
  });
  console.log("\n" + out.passed + " passed, " + out.failed + " failed, " + out.results.length + " total");
  process.exit(out.failed ? 1 : 0);
}
