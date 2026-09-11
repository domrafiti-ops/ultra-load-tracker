/*
 * Assertions for load-model.js.
 *
 * Every expected value here is either (a) reported directly in a cited paper,
 * or (b) hand-calculated during derivation and re-checked twice. This file is
 * the regression net: if a coefficient is edited, these break loudly.
 *
 * Run:  node tests/load-model.test.js
 * Or open tests/index.html in a browser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../lib/load-model.js"));
  } else {
    root.runLoadModelTests = function () { return factory(root.LoadModel); };
  }
})(typeof self !== "undefined" ? self : this, function (LM) {
  "use strict";

  var results = [];
  function check(name, actual, expected, tolPct, note) {
    var pass, detail;
    if (typeof expected === "number") {
      var err = expected === 0 ? Math.abs(actual) : Math.abs((actual - expected) / expected) * 100;
      pass = err <= tolPct;
      detail = "got " + fmt(actual) + ", expected " + fmt(expected) + " (" + err.toFixed(2) + "% off, tol " + tolPct + "%)";
    } else {
      pass = actual === expected;
      detail = "got " + actual + ", expected " + expected;
    }
    results.push({ name: name, pass: pass, detail: detail, note: note || "" });
    return pass;
  }
  function fmt(n) { return typeof n === "number" ? (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(4)) : String(n); }

  var PROFILE = { massKg: 70, male: true, hrMax: 188, hrRest: 46, descentStepLengthM: 1.05 };

  // -------------------------------------------------------------------------
  // 1. Minetti polynomials vs. the values reported in the 2002 paper itself
  // -------------------------------------------------------------------------
  check("Minetti Cr at level",        LM.costRun(0),      3.40,  6.0, "paper 3.40; polynomial intercept is 3.6");
  check("Minetti Cr at +45%",         LM.costRun(0.45),  18.93,  3.0, "paper 18.93");
  check("Minetti Cr minimum at -20%", LM.costRun(-0.20),  1.73,  5.0, "paper 1.73");
  check("Minetti Cr at -45%",         LM.costRun(-0.45),  3.92,  4.0, "paper 3.92");
  check("Minetti Cw at +45%",         LM.costWalk(0.45), 17.33,  2.0, "paper 17.33");
  check("Minetti Cw at -45%",         LM.costWalk(-0.45), 3.46,  5.0, "paper 3.46");
  // Documented failure mode, asserted so it cannot silently change:
  check("Minetti Cw is BAD at -10%",  LM.costWalk(-0.10), 1.127, 1.0, "paper 0.81 — polynomial is 39% high here");

  // Cross-check the vertical term against the independent ACSM walking equation.
  // 25% grade, 3.5 km/h: both models must agree on vertical efficiency ~26%.
  var cw25 = LM.costWalk(0.25);
  check("Cw at +25%", cw25, 9.4884, 0.5);
  check("Minetti vertical efficiency", 9.81 / (cw25 / 0.25), 0.259, 2.0, "ACSM implies 0.261 — independent agreement");

  // -------------------------------------------------------------------------
  // 2. Durability integral, closed form
  // -------------------------------------------------------------------------
  check("durability integral below onset", LM.durabilityIntegral(90), 90, 0.01);
  check("durability integral at 199.6 min", LM.durabilityIntegral(199.6), 203.104, 0.1);
  check("durability integral at cap", LM.durabilityIntegral(LM.DUR_CAP_AT_MIN), 681.45, 0.1);
  check("durability cap binds at ~604 min", LM.DUR_CAP_AT_MIN, 604.286, 0.1);
  check("durability weight is 1.0 early", LM.durabilityWeight(60), 1.0, 0.01);
  check("durability weight capped late", LM.durabilityWeight(2000), 1.30, 0.01);

  // -------------------------------------------------------------------------
  // 3. Eccentric channel — the calibration anchor must return exactly 100
  // -------------------------------------------------------------------------
  var ref = LM.eccentricReference();
  check("reference bout descent", ref.descentM, 904.0, 0.1);
  check("reference bout steps", ref.steps, 6800, 0.01);
  check("reference bout J/step", ref.perStepJ, 91.29, 0.1);

  // Closed form on the reference session
  var refSimple = LM.eccentricLoadSimple(
    { descentM: ref.descentM, distanceKm: ref.distanceM / 1000, ascentM: 0, packKg: 0 },
    { massKg: 70, descentStepLengthM: ref.stepLengthM }
  );
  check("reference bout = 100 AU (closed form)", refSimple.eccentric, 100.0, 0.1);

  // Segment form on the same session must agree with the closed form
  var refSeg = LM.eccentricLoadSegments([{
    distanceM: ref.distanceM, gradeFrac: -0.12,
    speedMs: 11.3 / 3.6, cadenceSpm: 170
  }], { massKg: 70 });
  check("reference bout = 100 AU (segment form)", refSeg.eccentric, 100.0, 0.1,
        "closed form and segment sum are algebraically identical at k=1.5");

  // -------------------------------------------------------------------------
  // 4. Eccentric channel — validation against a real race
  // Millet 2011: 166 km mountain ultra, 9500 m of descent.
  // Cohort finished with knee-extensor MVC -35%, CK 144 -> 13,633 UI/L,
  // 16 days to baseline. The model should price this as an order of magnitude
  // more than one canonical damaging bout.
  // -------------------------------------------------------------------------
  var millet = LM.eccentricLoadSegments([{
    distanceM: 9500 / 0.15, gradeFrac: -0.15, speedMs: 2.2, cadenceSpm: 165
  }], { massKg: 70 });
  check("Millet 2011 MUM eccentric load", millet.eccentric, 998, 1.0,
        "~10x the canonical muscle-damaging protocol");

  // Steep descent workout: 1000 m at -20%, 3.3 m/s
  var steep = LM.eccentricLoadSegments([{
    distanceM: 5000, gradeFrac: -0.20, speedMs: 3.3, cadenceSpm: 180
  }], { massKg: 70 });
  check("steep descent workout", steep.eccentric, 142.3, 1.0);

  // Exponent sensitivity: the race is insensitive, the steep workout is not.
  // This asymmetry is the reason k_m being assumed is tolerable.
  var milletK1 = LM.eccentricLoadSegments(
    [{ distanceM: 9500 / 0.15, gradeFrac: -0.15, speedMs: 2.2, cadenceSpm: 165 }],
    { massKg: 70, kMuscle: 1.0 }).eccentric;
  var milletK2 = LM.eccentricLoadSegments(
    [{ distanceM: 9500 / 0.15, gradeFrac: -0.15, speedMs: 2.2, cadenceSpm: 165 }],
    { massKg: 70, kMuscle: 2.0 }).eccentric;
  check("race is robust to k_m (k=1.0)", milletK1, 1051, 1.5);
  check("race is robust to k_m (k=2.0)", milletK2, 949, 1.5);
  var spread = Math.abs(milletK2 - milletK1) / millet.eccentric * 100;
  check("race k_m spread under 12%", spread < 12, true, null,
        "spread was " + spread.toFixed(1) + "%");

  // -------------------------------------------------------------------------
  // 5. Simple (5-field) form vs. full segment form — the whole premise of the
  // logger. Brevent-style loop: 21 km, 1706 m D+, 1656 m D-, 3 kg pack.
  // -------------------------------------------------------------------------
  var BREVENT_SEGMENTS = [
    { name: "Valley approach", distanceM: 2000, gradeFrac:  0.00, speedMs: 3.05, cadenceSpm: 172, avgHr: 138 },
    { name: "Lower climb",     distanceM: 4500, gradeFrac:  0.18, speedMs: 1.15, cadenceSpm: 150, avgHr: 152 },
    { name: "Upper climb",     distanceM: 3200, gradeFrac:  0.28, speedMs: 0.95, cadenceSpm: 145, avgHr: 158 },
    { name: "Summit descent",  distanceM: 4800, gradeFrac: -0.22, speedMs: 2.45, cadenceSpm: 176, avgHr: 150 },
    { name: "Forest descent",  distanceM: 5000, gradeFrac: -0.12, speedMs: 3.10, cadenceSpm: 178, avgHr: 145 },
    { name: "Valley return",   distanceM: 1500, gradeFrac:  0.00, speedMs: 3.20, cadenceSpm: 174, avgHr: 140 }
  ];
  var brevProfile = { massKg: 70, packKg: 3, male: true, hrMax: 188, hrRest: 46, descentStepLengthM: 1.05 };

  var segA = LM.aerobicLoadSegments(BREVENT_SEGMENTS, brevProfile);
  var segE = LM.eccentricLoadSegments(BREVENT_SEGMENTS, brevProfile);

  // Time-weighted average HR across the segments, as a watch would report it.
  var tSum = 0, hrSum = 0;
  BREVENT_SEGMENTS.forEach(function (g) {
    var m = (g.distanceM / g.speedMs) / 60;
    tSum += m; hrSum += m * g.avgHr;
  });
  var simple = LM.evaluateSession({
    durationMin: tSum, avgHr: hrSum / tSum, distanceKm: 21.0,
    ascentM: 1706, descentM: 1656, packKg: 3
  }, brevProfile);

  check("Brevent moving time", tSum, 199.6, 1.0);
  check("Brevent segment AeL", segA.aeL, 540.0, 1.0);
  check("Brevent simple AeL", simple.aeL, 538.9, 1.0);
  var aErr = Math.abs(simple.aeL - segA.aeL) / segA.aeL * 100;
  check("simple AeL within 1% of segments", aErr < 1.0, true, null,
        "error was " + aErr.toFixed(2) + "%");

  check("Brevent segment eccentric", segE.eccentric, 215.0, 1.5);
  check("Brevent simple eccentric", simple.eccentric, 219.3, 1.5);
  var eErr = Math.abs(simple.eccentric - segE.eccentric) / segE.eccentric * 100;
  check("simple eccentric within 4% of segments", eErr < 4.0, true, null,
        "error was " + eErr.toFixed(2) + "%");
  check("derived mean descent grade", simple.meanDescentGrade, 0.160, 3.0,
        "true weighted value is 0.169");

  // -------------------------------------------------------------------------
  // 6. Cyclic channel
  // -------------------------------------------------------------------------
  var cycRef = LM.cyclicLoadBuckets(
    [{ distanceM: 10000, minutes: 50, gradeFrac: 0 }], { cadenceSpm: 175 });
  check("cyclic reference = 100 AU", cycRef.cyclic, 100.0, 0.1);

  var cycFast = LM.cyclicLoadBuckets(
    [{ distanceM: 10000, minutes: 37.5, gradeFrac: 0 }], { cadenceSpm: 185 });
  check("10k at 16 km/h cyclic load", cycFast.cyclic, 210.3, 2.0,
        "33% faster more than doubles bone-channel load");

  check("speed exponent from Rice 2024", LM.SPEED_EXP, 1.1304, 0.2,
        "ln(1.31)/ln(16.0/12.6)");

  // B-hat must refuse to answer without a climb/descent split.
  var noSplit = LM.cyclicLoadSimple(
    { durationMin: 120, distanceKm: 16, ascentM: 900, descentM: 900 }, {});
  check("cyclic returns null without time split", noSplit.cyclic, null, null,
        "a fabricated B-hat is worse than no B-hat");

  // -------------------------------------------------------------------------
  // 7. Rules of thumb quoted in the UI
  // -------------------------------------------------------------------------
  check("~11 AU per 100 m descent at 12% grade", LM.eccentricPer100m(0.12, 70, 1.05), 11.0, 6.0);
  check("~14 AU per 100 m descent at 20% grade", LM.eccentricPer100m(0.20, 70, 1.05), 14.2, 6.0);
  check("~17 AU per 100 m descent at 30% grade", LM.eccentricPer100m(0.30, 70, 1.05), 17.4, 6.0);

  // -------------------------------------------------------------------------
  // 8. Sanity guards
  // -------------------------------------------------------------------------
  check("flat run has zero eccentric load",
    LM.evaluateSession({ durationMin: 50, avgHr: 150, distanceKm: 10, ascentM: 0, descentM: 0 }, PROFILE).eccentric,
    0, 0.01, "correctly zero — this is why the cyclic channel exists");
  check("altitude cuts VO2max above 1500 m",
    LM.altitudeAdjustedVO2max(60, 3500), 60 * (1 - 0.13), 0.1);
  check("altitude is a no-op below 1500 m",
    LM.altitudeAdjustedVO2max(60, 1000), 60, 0.01);
  check("1 h at 50% HRR is ~100 AU",
    LM.aerobicLoadSimple({ durationMin: 60, avgHr: 46 + 0.5 * 142 }, PROFILE).aeL, 100.3, 1.0);

  var failed = results.filter(function (r) { return !r.pass; });
  return { results: results, passed: results.length - failed.length, failed: failed.length };
});

// Node runner
if (typeof module === "object" && module.exports && require.main === module) {
  var out = module.exports;
  var pad = 46;
  out.results.forEach(function (r) {
    var line = (r.pass ? "  PASS  " : "  FAIL  ") + r.name;
    while (line.length < pad) line += " ";
    console.log(line + " " + r.detail + (r.note ? "   // " + r.note : ""));
  });
  console.log("\n" + out.passed + " passed, " + out.failed + " failed, " + out.results.length + " total");
  process.exit(out.failed ? 1 : 0);
}
