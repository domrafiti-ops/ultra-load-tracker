/*!
 * load-model.js — Two-Channel Ultra Load Model
 *
 * Pure functions. No DOM, no globals beyond the export. Runs in the browser
 * and under Node (for tests).
 *
 * Two independent load channels for mountain / ultra running:
 *   AeL  — aerobic (internal, cardiorespiratory) dose
 *   Ê/B̂ — mechanical (external, tissue) dose, split into eccentric and cyclic
 *
 * Never add AeL and MechL. They are a coordinate pair, not a total.
 *
 * Provenance for every coefficient is in docs/ and in model.html.
 * Coefficients marked ASSUMED below are judgement, not measurement.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LoadModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var G = 9.81;                 // m/s^2
  var J_PER_ML_O2 = 20.9;       // caloric equivalent at RER ~0.96 (range 19.6-21.1)
  var VO2_REST = 3.5;           // mL/kg/min
  var SPEED_EXP = 1.1304;       // DERIVED: ln(1.31)/ln(16.0/12.6), Rice et al. 2024
  var K_BONE_DEFAULT = 3.0;     // ASSUMED: gentle end of cortical-bone fatigue-life exponents
  var K_MUSCLE_DEFAULT = 1.5;   // ASSUMED: no published eccentric-damage dose-response exponent
  var SL_DESCENT_DEFAULT = 1.05;// ASSUMED: typical trail descent step length, m

  // Durability up-weight: threshold intensities migrate down during long efforts.
  // Slope DERIVED from Hunter 2025 (5.5% / 90 min) and Hamilton 2024 (6% / 150 min).
  // Onset and cap are ASSUMED.
  var DUR_ONSET_MIN = 90;
  var DUR_SLOPE_PER_H = 0.035;
  var DUR_CAP = 1.30;
  var DUR_CAP_AT_MIN = DUR_ONSET_MIN + 60 * ((DUR_CAP - 1) / DUR_SLOPE_PER_H); // 604.286

  // ---------------------------------------------------------------------------
  // Minetti et al. 2002 gradient cost polynomials, J/kg/m, net of resting.
  // Verified against the paper's own reported extremes to within 1.6-5.9%.
  // KNOWN FAILURE: costWalk is ~39% high at its -10% minimum. Do not use the
  // walking polynomial for shallow downhill.
  // ---------------------------------------------------------------------------
  function costRun(i) {
    return 155.4 * Math.pow(i, 5) - 30.4 * Math.pow(i, 4) - 43.3 * Math.pow(i, 3)
         + 46.3 * i * i + 19.5 * i + 3.6;
  }
  function costWalk(i) {
    return 280.5 * Math.pow(i, 5) - 58.7 * Math.pow(i, 4) - 76.8 * Math.pow(i, 3)
         + 51.9 * i * i + 19.6 * i + 2.5;
  }
  /** gait: "run" | "walk" | "auto" (auto hikes above +20% grade) */
  function costGrade(i, gait) {
    if (gait === "walk") return costWalk(i);
    if (gait === "run") return costRun(i);
    return i > 0.20 ? costWalk(i) : costRun(i);
  }

  // ---------------------------------------------------------------------------
  // Calibration references. Both are computed, not hardcoded, so the reference
  // sessions return exactly 100 AU by construction.
  // ---------------------------------------------------------------------------

  // Eccentric reference = the canonical muscle-damaging downhill protocol,
  // characterised by the medians in Bontemps et al. 2020:
  // -12% grade, 40 min, 11.3 km/h, at 70 kg and 170 spm.
  var REF_ECC = {
    massKg: 70, gradeFrac: 0.12, durationMin: 40, speedKmh: 11.3, cadenceSpm: 170
  };
  function eccentricReference() {
    var v = REF_ECC.speedKmh / 3.6;
    var distanceM = v * REF_ECC.durationMin * 60;
    var descentM = distanceM * REF_ECC.gradeFrac;
    var steps = REF_ECC.cadenceSpm * REF_ECC.durationMin;
    var perStepJ = REF_ECC.massKg * G * descentM / steps;
    return {
      distanceM: distanceM, descentM: descentM, steps: steps,
      stepLengthM: distanceM / steps, perStepJ: perStepJ,
      raw: steps * Math.pow(perStepJ, K_MUSCLE_DEFAULT)
    };
  }
  var E_REF = eccentricReference().raw;   // ~5.9313e6

  // Cyclic reference = flat 10 km at 12 km/h, 175 spm.
  var REF_CYC = { distanceM: 10000, speedKmh: 12, cadenceSpm: 175 };
  var V_REF = REF_CYC.speedKmh / 3.6;     // 3.3333 m/s
  var B_REF = REF_CYC.cadenceSpm * (REF_CYC.distanceM / V_REF) / 60; // 8750 steps

  // Grade factor for the cyclic channel. ASSUMED magnitudes; the direction is
  // supported (Vernillo 2017: uphill raises duty factor, cutting peak force).
  function gradeFactor(gradeFrac) {
    if (gradeFrac < -0.01) return 1.2;
    if (gradeFrac > 0.01) return 0.7;
    return 1.0;
  }

  // ---------------------------------------------------------------------------
  // AEROBIC CHANNEL
  // ---------------------------------------------------------------------------

  /** Banister TRIMP weighting, fitted to the delta-HR / blood-lactate relation. */
  function trimpWeight(F, male) {
    var f = Math.max(0, Math.min(F, 1.15));
    return male ? 0.64 * Math.exp(1.92 * f) : 0.86 * Math.exp(1.67 * f);
  }

  /** Instantaneous durability weight at elapsed minute t. */
  function durabilityWeight(t) {
    return Math.min(1 + DUR_SLOPE_PER_H * Math.max(0, (t - DUR_ONSET_MIN) / 60), DUR_CAP);
  }

  /** Closed-form integral of durabilityWeight from 0 to T minutes. */
  function durabilityIntegral(T) {
    if (T <= DUR_ONSET_MIN) return T;
    if (T <= DUR_CAP_AT_MIN) {
      return T + (DUR_SLOPE_PER_H / 120) * Math.pow(T - DUR_ONSET_MIN, 2);
    }
    var atCap = DUR_CAP_AT_MIN + (DUR_SLOPE_PER_H / 120) * Math.pow(DUR_CAP_AT_MIN - DUR_ONSET_MIN, 2);
    return atCap + DUR_CAP * (T - DUR_CAP_AT_MIN);
  }

  function reserveFractionHR(avgHr, hrRest, hrMax) {
    var span = Math.max(hrMax - hrRest, 1);
    return (avgHr - hrRest) / span;
  }

  /**
   * Terrain-derived intensity when heart rate is unavailable (Tier B).
   * Minetti costs are net of resting, so the denominator is VO2 reserve —
   * which is what licenses feeding it into a weighting fitted to %HRR,
   * since %VO2R ~= %HRR.
   */
  function reserveFractionTerrain(o) {
    var vo2maxAlt = altitudeAdjustedVO2max(o.vo2max, o.altitudeM || 0);
    var massRatio = (o.massKg + (o.packKg || 0)) / Math.max(o.massKg, 1);
    var c = costGrade(o.gradeFrac, o.gait || "auto");
    var vo2 = 60 * massRatio * c * o.speedMs / J_PER_ML_O2;   // net mL/kg/min
    return vo2 / Math.max(vo2maxAlt - VO2_REST, 1);
  }

  /** ASSUMED coefficient: commonly cited ~6.5%/1000 m above 1500 m. Unverified. */
  function altitudeAdjustedVO2max(vo2max, altitudeM) {
    return vo2max * (1 - 0.065 * Math.max(0, (altitudeM - 1500) / 1000));
  }

  /**
   * Whole-session aerobic load from average heart rate.
   * Error vs. segment integration is ~1.843 * variance(F) — under 3% for
   * continuous running, ~7% for sessions containing hard intervals.
   */
  function aerobicLoadSimple(s, p) {
    var F = reserveFractionHR(s.avgHr, p.hrRest, p.hrMax);
    return {
      aeL: trimpWeight(F, p.male) * durabilityIntegral(s.durationMin),
      reserveFraction: F
    };
  }

  /** Segment-by-segment aerobic load. Ground truth for the simple form. */
  function aerobicLoadSegments(segments, p) {
    var elapsed = 0, total = 0;
    segments.forEach(function (g) {
      var mins = g.durationMin != null
        ? g.durationMin
        : (g.distanceM / g.speedMs) / 60;
      var F = g.avgHr != null
        ? reserveFractionHR(g.avgHr, p.hrRest, p.hrMax)
        : reserveFractionTerrain({
            gradeFrac: g.gradeFrac, speedMs: g.speedMs, massKg: p.massKg,
            packKg: p.packKg, vo2max: p.vo2max, altitudeM: p.altitudeM, gait: g.gait
          });
      total += mins * trimpWeight(F, p.male) * durabilityWeight(elapsed + mins / 2);
      elapsed += mins;
    });
    return { aeL: total, movingMin: elapsed };
  }

  // ---------------------------------------------------------------------------
  // MECHANICAL CHANNEL — eccentric (Ê)
  // ---------------------------------------------------------------------------

  /**
   * Segment form. Damage accumulates as cycles x magnitude^k, the same
   * structure as a bone S-N fatigue curve. Climbs contribute zero.
   */
  function eccentricLoadSegments(segments, p) {
    var km = p.kMuscle != null ? p.kMuscle : K_MUSCLE_DEFAULT;
    var mTot = p.massKg + (p.packKg || 0);
    var raw = 0;
    segments.forEach(function (g) {
      if (g.gradeFrac >= 0) return;
      var mins = g.durationMin != null ? g.durationMin : (g.distanceM / g.speedMs) / 60;
      var steps = g.cadenceSpm * mins;
      var descentM = g.distanceM * Math.abs(g.gradeFrac);
      if (steps <= 0 || descentM <= 0) return;
      var perStepJ = mTot * G * descentM / steps;
      raw += steps * Math.pow(perStepJ, km);
    });
    return { eccentric: 100 * raw / referenceRaw(km), raw: raw };
  }

  /** E_ref recomputed for a non-default exponent so 100 AU stays anchored. */
  function referenceRaw(km) {
    if (Math.abs(km - K_MUSCLE_DEFAULT) < 1e-12) return E_REF;
    var r = eccentricReference();
    return r.steps * Math.pow(r.perStepJ, km);
  }

  /**
   * Whole-session form. At k = 1.5 the segment sum collapses exactly:
   *   sum N*(m*g*h/N)^1.5  ->  (m*g)^1.5 * D * sqrt(grade * stepLength)
   * so descent metres enter LINEARLY and grade/step-length only under a root.
   * A 20% error in either moves the result by 10%.
   */
  function eccentricLoadSimple(s, p) {
    var km = p.kMuscle != null ? p.kMuscle : K_MUSCLE_DEFAULT;
    var mTot = p.massKg + (s.packKg || 0);
    var sl = p.descentStepLengthM || SL_DESCENT_DEFAULT;
    var out = { eccentric: 0, meanDescentGrade: 0, descentDistanceM: 0 };
    if (!(s.descentM > 0) || !(s.distanceKm > 0)) return out;

    // Split distance between climbing and descending in proportion to D+ / D-.
    // On the worked example this recovers 0.160 against a true weighted 0.169.
    var vert = (s.ascentM || 0) + s.descentM;
    var dDownM = vert > 0 ? s.distanceKm * 1000 * (s.descentM / vert) : s.distanceKm * 1000;
    var grade = dDownM > 0 ? s.descentM / dDownM : 0;
    grade = Math.max(0.005, Math.min(grade, 0.60));
    out.meanDescentGrade = grade;
    out.descentDistanceM = dDownM;

    if (Math.abs(km - 1.5) < 1e-12) {
      out.eccentric = 100 * Math.pow(mTot * G, 1.5) * s.descentM
                    * Math.sqrt(grade * sl) / E_REF;
    } else {
      var steps = dDownM / sl;
      var perStepJ = mTot * G * s.descentM / Math.max(steps, 1);
      out.eccentric = 100 * steps * Math.pow(perStepJ, km) / referenceRaw(km);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // MECHANICAL CHANNEL — cyclic (B̂)
  // ---------------------------------------------------------------------------

  /**
   * Effective speed exponent is SPEED_EXP * kBone ~= 3.39, so this channel
   * CANNOT be computed from a session-average speed: averaging a 4 km/h hike
   * with an 11 km/h descent under-counts by more than half. It needs buckets.
   *
   * buckets: [{ distanceM, minutes, gradeFrac }]
   */
  function cyclicLoadBuckets(buckets, p) {
    var kb = p.kBone != null ? p.kBone : K_BONE_DEFAULT;
    var cad = p.cadenceSpm || 176;
    var raw = 0, any = false;
    buckets.forEach(function (b) {
      if (!(b.distanceM > 0) || !(b.minutes > 0)) return;
      any = true;
      var v = b.distanceM / (b.minutes * 60);
      var steps = cad * b.minutes;
      raw += steps * Math.pow(Math.pow(v / V_REF, SPEED_EXP) * gradeFactor(b.gradeFrac), kb);
    });
    return any ? { cyclic: 100 * raw / B_REF, raw: raw } : { cyclic: null, raw: 0 };
  }

  /**
   * Build the three speed buckets from a simple session record.
   * Returns null when the climb/descent time split is missing — deliberately,
   * because a fabricated B̂ is worse than no B̂.
   */
  function cyclicLoadSimple(s, p) {
    if (!(s.descentMin > 0) || !(s.climbMin > 0) || !(s.distanceKm > 0)) {
      return { cyclic: null };
    }
    var vert = (s.ascentM || 0) + s.descentM;
    var totalM = s.distanceKm * 1000;
    var dDown = vert > 0 ? totalM * (s.descentM / vert) : 0;
    var dUp = vert > 0 ? totalM * ((s.ascentM || 0) / vert) : 0;
    var dFlat = Math.max(totalM - dDown - dUp, 0);
    var flatMin = Math.max(s.durationMin - s.descentMin - s.climbMin, 0);
    return cyclicLoadBuckets([
      { distanceM: dDown, minutes: s.descentMin, gradeFrac: -0.15 },
      { distanceM: dUp,   minutes: s.climbMin,   gradeFrac:  0.15 },
      { distanceM: dFlat, minutes: flatMin,      gradeFrac:  0 }
    ], { kBone: p.kBone, cadenceSpm: s.cadenceSpm || p.cadenceSpm });
  }

  // ---------------------------------------------------------------------------
  // TOP LEVEL
  // ---------------------------------------------------------------------------

  /**
   * Evaluate one logged session.
   * session: { durationMin, avgHr, distanceKm, ascentM, descentM,
   *            packKg?, descentMin?, climbMin?, cadenceSpm? }
   * profile: { massKg, male, hrMax, hrRest, descentStepLengthM?,
   *            kMuscle?, kBone?, cadenceSpm? }
   */
  function evaluateSession(session, profile) {
    var a = aerobicLoadSimple(session, profile);
    var e = eccentricLoadSimple(session, profile);
    var c = cyclicLoadSimple(session, profile);
    return {
      aeL: a.aeL,
      reserveFraction: a.reserveFraction,
      eccentric: e.eccentric,
      cyclic: c.cyclic,
      meanDescentGrade: e.meanDescentGrade,
      descentDistanceM: e.descentDistanceM
    };
  }

  /** Blended mechanical scalar. Convenience only — prefer reporting the pair. */
  function blendMechanical(eccentric, cyclic, omega, kPole, kSurface) {
    var w = omega == null ? 0.25 : omega;
    var b = cyclic == null ? eccentric : cyclic;
    return ((1 - w) * eccentric + w * b) * (kPole || 1) * (kSurface || 1);
  }

  /** AU of eccentric load per 100 m of descent, for back-of-envelope route pricing. */
  function eccentricPer100m(gradeFrac, massKg, stepLengthM) {
    return eccentricLoadSimple(
      { descentM: 100, distanceKm: (100 / gradeFrac) / 1000, ascentM: 0, packKg: 0 },
      { massKg: massKg || 70, descentStepLengthM: stepLengthM || SL_DESCENT_DEFAULT }
    ).eccentric;
  }

  return {
    G: G, E_REF: E_REF, B_REF: B_REF, V_REF: V_REF,
    SPEED_EXP: SPEED_EXP, DUR_CAP_AT_MIN: DUR_CAP_AT_MIN,
    REF_ECC: REF_ECC, REF_CYC: REF_CYC,
    costRun: costRun, costWalk: costWalk, costGrade: costGrade,
    altitudeAdjustedVO2max: altitudeAdjustedVO2max,
    trimpWeight: trimpWeight,
    durabilityWeight: durabilityWeight,
    durabilityIntegral: durabilityIntegral,
    reserveFractionHR: reserveFractionHR,
    reserveFractionTerrain: reserveFractionTerrain,
    aerobicLoadSimple: aerobicLoadSimple,
    aerobicLoadSegments: aerobicLoadSegments,
    eccentricLoadSimple: eccentricLoadSimple,
    eccentricLoadSegments: eccentricLoadSegments,
    eccentricReference: eccentricReference,
    cyclicLoadSimple: cyclicLoadSimple,
    cyclicLoadBuckets: cyclicLoadBuckets,
    evaluateSession: evaluateSession,
    blendMechanical: blendMechanical,
    eccentricPer100m: eccentricPer100m
  };
});
