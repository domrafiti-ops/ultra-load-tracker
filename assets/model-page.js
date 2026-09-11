/* model-page.js — segment calculator and Minetti curve for model.html. */
(function () {
  "use strict";
  var LM = window.LoadModel;

  var EXAMPLE = [
    { n: "Valley approach", d: 2.0, g: 0,   v: 10.98, c: 172, hr: 138 },
    { n: "Lower climb",     d: 4.5, g: 18,  v: 4.14,  c: 150, hr: 152 },
    { n: "Upper climb",     d: 3.2, g: 28,  v: 3.42,  c: 145, hr: 158 },
    { n: "Summit descent",  d: 4.8, g: -22, v: 8.82,  c: 176, hr: 150 },
    { n: "Forest descent",  d: 5.0, g: -12, v: 11.16, c: 178, hr: 145 },
    { n: "Valley return",   d: 1.5, g: 0,   v: 11.52, c: 174, hr: 140 }
  ];

  function $(id) { return document.getElementById(id); }
  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var body = $("segBody");

  function cell(v, cls) {
    return '<td><input type="number" step="any" class="' + (cls || "") + '" value="' + v + '"></td>';
  }
  function addRow(s) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><input type="text" class="name" value="' + esc(s.n) + '"></td>' +
      cell(s.d) + cell(s.g) + cell(s.v) + cell(s.c) + cell(s.hr) +
      '<td class="tnum o">—</td><td class="tnum o">—</td>' +
      '<td class="tnum o ae">—</td><td class="tnum o me">—</td>';
    body.appendChild(tr);
  }
  function load() { body.innerHTML = ""; EXAMPLE.forEach(addRow); }

  function readSegments() {
    var out = [];
    Array.prototype.forEach.call(body.querySelectorAll("tr"), function (tr) {
      var f = tr.querySelectorAll("input");
      var distKm = parseFloat(f[1].value) || 0;
      var v = (parseFloat(f[3].value) || 0) / 3.6;
      if (distKm <= 0 || v <= 0) { out.push(null); return; }
      out.push({
        row: tr,
        name: f[0].value,
        distanceM: distKm * 1000,
        gradeFrac: (parseFloat(f[2].value) || 0) / 100,
        speedMs: v,
        cadenceSpm: parseFloat(f[4].value) || 0,
        avgHr: parseFloat(f[5].value) || 0
      });
    });
    return out;
  }

  function compute() {
    var profile = {
      massKg: num("mBody"), packKg: num("mPack"),
      male: $("sex").value === "m",
      hrMax: num("hrMax"), hrRest: num("hrRest"),
      vo2max: num("vo2"), altitudeM: num("alt"),
      kMuscle: num("km")
    };
    var tier = $("tier").value;
    var raw = readSegments();
    var segs = raw.filter(Boolean);

    // Tier B ignores heart rate entirely.
    var forModel = segs.map(function (s) {
      var copy = {
        distanceM: s.distanceM, gradeFrac: s.gradeFrac,
        speedMs: s.speedMs, cadenceSpm: s.cadenceSpm
      };
      if (tier === "A") copy.avgHr = s.avgHr;
      return copy;
    });

    var aer = LM.aerobicLoadSegments(forModel, profile);
    var ecc = LM.eccentricLoadSegments(forModel, profile);

    // Per-row figures. The aerobic term is built directly rather than by
    // calling the segment integrator per row, so delta(t) uses each segment's
    // true position in elapsed time.
    var elapsed = 0, up = 0, down = 0;
    segs.forEach(function (s, i) {
      var m = forModel[i];
      var mins = (m.distanceM / m.speedMs) / 60;
      var F = m.avgHr != null
        ? LM.reserveFractionHR(m.avgHr, profile.hrRest, profile.hrMax)
        : LM.reserveFractionTerrain({
            gradeFrac: m.gradeFrac, speedMs: m.speedMs, massKg: profile.massKg,
            packKg: profile.packKg, vo2max: profile.vo2max, altitudeM: profile.altitudeM
          });
      var rowAeL = mins * LM.trimpWeight(F, profile.male) * LM.durabilityWeight(elapsed + mins / 2);
      var rowEcc = LM.eccentricLoadSegments([m], profile).eccentric;
      var vert = m.distanceM * m.gradeFrac;
      if (vert > 0) up += vert; else down += -vert;

      var o = s.row.querySelectorAll("td.o");
      o[0].textContent = mins.toFixed(1);
      o[1].textContent = (vert >= 0 ? "+" : "") + Math.round(vert);
      o[2].textContent = Math.round(rowAeL);
      o[3].textContent = Math.round(rowEcc);
      elapsed += mins;
    });

    $("oAeL").textContent = Math.round(aer.aeL);
    $("oE").textContent = Math.round(ecc.eccentric);
    $("oTier").textContent = "tier " + tier;
    var h = Math.floor(elapsed / 60), m = Math.round(elapsed - h * 60);
    if (m === 60) { h += 1; m = 0; }
    $("oT").textContent = h + ":" + (m < 10 ? "0" : "") + m;
    $("oV").textContent = Math.round(up) + " / " + Math.round(down);
  }

  function drawCurve() {
    var svg = $("minetti");
    var W = 760, H = 340, L = 58, R = 16, T = 18, Bm = 44;
    var x0 = -0.45, x1 = 0.45, y1 = 20;
    function X(i) { return L + (i - x0) / (x1 - x0) * (W - L - R); }
    function Y(c) { return H - Bm - (c / y1) * (H - T - Bm); }
    var s = "";
    for (var c = 0; c <= 20; c += 5) {
      s += '<line x1="' + L + '" y1="' + Y(c) + '" x2="' + (W - R) + '" y2="' + Y(c) +
           '" stroke="var(--line)" stroke-width="1"/>' +
           '<text x="' + (L - 9) + '" y="' + (Y(c) + 4) + '" text-anchor="end" fill="var(--muted)" ' +
           'font-family="IBM Plex Mono, monospace" font-size="11">' + c + "</text>";
    }
    [-0.45, -0.30, -0.15, 0, 0.15, 0.30, 0.45].forEach(function (i) {
      s += '<line x1="' + X(i) + '" y1="' + Y(0) + '" x2="' + X(i) + '" y2="' + (Y(0) + 5) +
           '" stroke="var(--line-2)" stroke-width="1"/>' +
           '<text x="' + X(i) + '" y="' + (Y(0) + 20) + '" text-anchor="middle" fill="var(--muted)" ' +
           'font-family="IBM Plex Mono, monospace" font-size="11">' +
           (i > 0 ? "+" : "") + Math.round(i * 100) + "%</text>";
    });
    s += '<line x1="' + X(0) + '" y1="' + T + '" x2="' + X(0) + '" y2="' + Y(0) +
         '" stroke="var(--line-2)" stroke-width="1" stroke-dasharray="3 3"/>' +
         '<line x1="' + L + '" y1="' + Y(3.6) + '" x2="' + (W - R) + '" y2="' + Y(3.6) +
         '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 4"/>';

    function path(fn) {
      var p = "", first = true;
      for (var i = x0; i <= x1 + 1e-9; i += 0.005) {
        var v = fn(i);
        if (v < 0) v = 0;
        if (v > y1) continue;
        p += (first ? "M" : "L") + X(i).toFixed(1) + " " + Y(v).toFixed(1) + " ";
        first = false;
      }
      return p;
    }
    s += '<path d="' + path(LM.costWalk) + '" fill="none" stroke="var(--mech)" stroke-width="2.2" stroke-linejoin="round"/>';
    s += '<path d="' + path(LM.costRun) + '" fill="none" stroke="var(--aero)" stroke-width="2.2" stroke-linejoin="round"/>';

    var rmin = LM.costRun(-0.20), wq = LM.costWalk(0.25);
    s += '<circle cx="' + X(-0.20) + '" cy="' + Y(rmin) + '" r="4" fill="var(--aero)"/>' +
         '<text x="' + (X(-0.20) + 9) + '" y="' + (Y(rmin) - 9) + '" fill="var(--aero)" ' +
         'font-family="IBM Plex Mono, monospace" font-size="11">run min ' + rmin.toFixed(1) + ' @ −20%</text>' +
         '<circle cx="' + X(0.25) + '" cy="' + Y(wq) + '" r="4" fill="var(--mech)"/>' +
         '<text x="' + (X(0.25) - 8) + '" y="' + (Y(wq) + 18) + '" text-anchor="end" fill="var(--mech)" ' +
         'font-family="IBM Plex Mono, monospace" font-size="11">walk ' + wq.toFixed(1) + ' @ +25%</text>' +
         '<text x="' + (L - 42) + '" y="' + (T + 8) + '" fill="var(--muted)" ' +
         'font-family="IBM Plex Mono, monospace" font-size="11">J·kg⁻¹·m⁻¹</text>' +
         '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 8) + '" text-anchor="middle" fill="var(--muted)" ' +
         'font-family="IBM Plex Mono, monospace" font-size="11">gradient i (rise / run)</text>';
    svg.innerHTML = s;
  }

  function init() {
    $("addRow").addEventListener("click", function () {
      addRow({ n: "New segment", d: 1, g: 0, v: 10, c: 170, hr: 140 });
      compute();
    });
    $("delRow").addEventListener("click", function () {
      if (body.rows.length > 1) { body.deleteRow(body.rows.length - 1); compute(); }
    });
    $("reset").addEventListener("click", function () { load(); compute(); });
    document.addEventListener("input", compute);
    document.addEventListener("change", compute);
    load(); compute(); drawCurve();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
