/* app.js — Load Log UI.
 *
 * Storage is delegated entirely to lib/store.js: JSONBin is the source of
 * truth, localStorage is an offline cache. The app never writes a derived
 * value — AeL, Ê and B̂ are recomputed on every render from lib/load-model.js.
 */
(function () {
  "use strict";
  var LM = window.LoadModel, S = window.Store;

  var doc = S.emptyDoc();
  var config = { binId: "", accessKey: "" };
  var dirty = false;
  var editingId = null;
  var syncing = false;

  function $(id) { return document.getElementById(id); }
  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; }
  function optNum(id) {
    var s = ($(id).value || "").trim();
    if (!s) return null;
    var v = parseFloat(s);
    return isFinite(v) ? v : null;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function note(msg, kind) {
    var el = $("note");
    el.textContent = msg || "";
    el.className = "savenote" + (kind ? " " + kind : "");
  }
  function syncNote(msg, kind) {
    var el = $("syncNote");
    el.textContent = msg || "";
    el.className = "savenote" + (kind ? " " + kind : "");
  }

  // ------------------------------------------------------------- form <-> doc ---

  function readProfileForm() {
    return {
      massKg: num("mBody"), male: $("sex").value === "m",
      hrMax: num("hrMax"), hrRest: num("hrRest"),
      descentStepLengthM: num("sl"), kMuscle: num("km"), kBone: num("kb")
    };
  }
  function writeProfileForm(p) {
    if (!p) return;
    if (p.massKg) $("mBody").value = p.massKg;
    if (typeof p.male === "boolean") $("sex").value = p.male ? "m" : "f";
    if (p.hrMax) $("hrMax").value = p.hrMax;
    if (p.hrRest) $("hrRest").value = p.hrRest;
    if (p.descentStepLengthM) $("sl").value = p.descentStepLengthM;
    if (p.kMuscle) $("km").value = p.kMuscle;
    if (p.kBone) $("kb").value = p.kBone;
  }

  function readSessionForm() {
    return {
      id: editingId || S.newId(),
      date: $("date").value || new Date().toISOString().slice(0, 10),
      label: ($("label").value || "").trim() || "Session",
      durationMin: num("dur"), avgHr: num("hr"), distanceKm: num("dist"),
      ascentM: num("up"), descentM: num("down"),
      descentMin: optNum("dmin") || 0, climbMin: optNum("umin") || 0,
      cadenceSpm: optNum("cad") || 0, packKg: num("pack"),
      rpe: optNum("rpe"), soreness: optNum("sore"),
      editedAt: S.now()
    };
  }
  function writeSessionForm(s) {
    $("date").value = s.date || "";
    $("label").value = s.label || "";
    $("dur").value = s.durationMin || "";
    $("hr").value = s.avgHr || "";
    $("dist").value = s.distanceKm || "";
    $("up").value = s.ascentM || "";
    $("down").value = s.descentM || "";
    $("dmin").value = s.descentMin || "";
    $("umin").value = s.climbMin || "";
    $("cad").value = s.cadenceSpm || "";
    $("pack").value = s.packKg || 0;
    $("rpe").value = s.rpe == null ? "" : s.rpe;
    $("sore").value = s.soreness == null ? "" : s.soreness;
  }
  function clearForm() {
    editingId = null;
    $("date").value = new Date().toISOString().slice(0, 10);
    $("label").value = "";
    ["dmin", "umin", "cad", "rpe", "sore"].forEach(function (k) { $(k).value = ""; });
    setEditMode();
  }
  function setEditMode() {
    var editing = !!editingId;
    $("save").textContent = editing ? "Update session" : "Add to log";
    $("cancelEdit").hidden = !editing;
    $("editBanner").hidden = !editing;
  }

  // ------------------------------------------------------------------ persist ---

  function persist() {
    doc.profile = readProfileForm();
    S.saveLocal(doc, config, dirty);
  }

  function pushRemote(reason) {
    if (!S.configured(config)) { renderSyncState(); return Promise.resolve(); }
    if (syncing) return Promise.resolve();
    syncing = true;
    renderSyncState();
    return S.syncPush(config, doc).then(function (merged) {
      doc = merged;
      dirty = false;
      writeProfileForm(doc.profile);
      S.saveLocal(doc, config, false);
      syncing = false;
      render();
      syncNote("Synced " + (reason || "") + " · rev " + doc.rev + " · " +
               S.liveSessions(doc).length + " sessions in the bin", "ok");
    }).catch(function (e) {
      syncing = false;
      dirty = true;
      S.saveLocal(doc, config, true);
      render();
      syncNote(S.explain(e), "bad");
    });
  }

  function pullRemote() {
    if (!S.configured(config)) { syncNote("Add your Bin ID and Access Key first.", "bad"); return; }
    if (syncing) return;
    syncing = true;
    renderSyncState();
    S.remoteRead(config).then(function (remote) {
      doc = S.mergeDocs(doc, remote);
      dirty = false;
      writeProfileForm(doc.profile);
      S.saveLocal(doc, config, false);
      syncing = false;
      render();
      syncNote("Pulled " + S.liveSessions(doc).length + " sessions · rev " + doc.rev, "ok");
    }).catch(function (e) {
      syncing = false;
      renderSyncState();
      syncNote(S.explain(e), "bad");
    });
  }

  // ------------------------------------------------------------------- render ---

  function refreshLive() {
    var p = readProfileForm();
    var r = LM.evaluateSession(readSessionForm(), p);
    $("oAeL").textContent = isFinite(r.aeL) ? Math.round(r.aeL) : "—";
    $("oE").textContent = Math.round(r.eccentric);
    $("oB").textContent = r.cyclic == null ? "—" : Math.round(r.cyclic);
    $("oBu").textContent = r.cyclic == null ? "B̂ · add climb + descent min" : "B̂ · AU";
    $("oG").textContent = r.meanDescentGrade ? (r.meanDescentGrade * 100).toFixed(1) : "—";
    $("oF").textContent = isFinite(r.reserveFraction) ? Math.round(r.reserveFraction * 100) : "—";
  }

  function renderSyncState() {
    var tag = $("syncTag");
    if (syncing) { tag.textContent = "Sync: working…"; return; }
    if (!S.configured(config)) { tag.textContent = "Sync: local only"; return; }
    tag.textContent = dirty ? "Sync: pending changes" : "Sync: up to date";
  }

  function renderStorage() {
    var info = S.sizeInfo(doc);
    $("szBytes").textContent = (info.bytes / 1024).toFixed(1);
    $("szPct").textContent = Math.round(info.pct * 100);
    $("szBar").style.width = Math.min(info.pct * 100, 100) + "%";
    $("szBar").style.background = info.over ? "var(--bad)"
      : info.warn ? "var(--flag)" : "var(--aero)";
    $("szRoom").textContent = info.sessionsRemaining == null
      ? "—" : info.sessionsRemaining;
    var warn = $("szWarn");
    if (info.over) {
      warn.hidden = false;
      warn.textContent = "Over the 100 KB free-tier cap — writes will be rejected. " +
        "Export CSV, then archive sessions older than a year.";
      warn.className = "savenote bad";
    } else if (info.warn) {
      warn.hidden = false;
      warn.textContent = "Past 80 % of the 100 KB cap. Export CSV and archive soon.";
      warn.className = "savenote bad";
    } else {
      warn.hidden = true;
    }
  }

  function render() {
    var p = readProfileForm();
    doc.profile = p;
    var live = S.liveSessions(doc);

    // --- session table ---
    var tb = $("logBody");
    tb.innerHTML = "";
    $("logEmpty").hidden = live.length > 0;
    live.forEach(function (s) {
      var r = LM.evaluateSession(s, p);
      var tr = document.createElement("tr");
      if (s.id === editingId) tr.className = "editing";
      tr.innerHTML =
        "<td>" + esc(s.date) + "</td>" +
        '<td class="lbl">' + esc(s.label) + "</td>" +
        "<td>" + Math.round(s.durationMin) + "</td>" +
        "<td>" + Math.round(s.avgHr) + "</td>" +
        "<td>" + (s.distanceKm || 0).toFixed(1) + "</td>" +
        "<td>" + Math.round(s.ascentM || 0) + "</td>" +
        "<td>" + Math.round(s.descentM || 0) + "</td>" +
        '<td class="ae">' + Math.round(r.aeL) + "</td>" +
        '<td class="me">' + Math.round(r.eccentric) + "</td>" +
        '<td class="me">' + (r.cyclic == null ? "—" : Math.round(r.cyclic)) + "</td>" +
        "<td>" + (s.rpe == null ? "—" : s.rpe) + "</td>" +
        "<td>" + (s.soreness == null ? "—" : s.soreness) + "</td>" +
        '<td><button type="button" class="del ed" data-id="' + esc(s.id) + '" ' +
          'title="Edit — use this to add next-day soreness">edit</button></td>' +
        '<td><button type="button" class="del rm" data-id="' + esc(s.id) + '" ' +
          'aria-label="Delete session">×</button></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll("button.ed").forEach(function (b) {
      b.addEventListener("click", function () { beginEdit(b.getAttribute("data-id")); });
    });
    tb.querySelectorAll("button.rm").forEach(function (b) {
      b.addEventListener("click", function () { removeSession(b.getAttribute("data-id")); });
    });

    renderWeeks(p);
    renderRolling(p);
    renderCorrelations(p);
    renderStorage();
    renderSyncState();
  }

  function renderWeeks(p) {
    var weeks = S.weeklyRollup(doc, function (s) { return LM.evaluateSession(s, p); });
    var tb = $("weekBody");
    tb.innerHTML = "";
    $("weekEmpty").hidden = weeks.length > 0;
    weeks.forEach(function (w) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(w.week) + "</td>" +
        "<td>" + w.sessions + "</td>" +
        "<td>" + Math.round(w.durationMin / 6) / 10 + "</td>" +
        "<td>" + Math.round(w.distanceKm) + "</td>" +
        "<td>" + Math.round(w.ascentM) + "</td>" +
        "<td>" + Math.round(w.descentM) + "</td>" +
        '<td class="ae">' + Math.round(w.aeL) + "</td>" +
        '<td class="me">' + Math.round(w.ecc) + "</td>" +
        "<td>" + (w.divergence == null ? "—" : w.divergence.toFixed(2)) + "</td>" +
        "<td>" + (w.meanRpe == null ? "—" : w.meanRpe.toFixed(1)) + "</td>" +
        "<td>" + (w.meanSoreness == null ? "—" : w.meanSoreness.toFixed(1)) + "</td>";
      tb.appendChild(tr);
    });
  }

  function renderRolling(p) {
    var today = new Date(), a7 = 0, m7 = 0, a14 = 0, m14 = 0, c7 = 0;
    S.liveSessions(doc).forEach(function (s) {
      var r = LM.evaluateSession(s, p);
      var age = (today - new Date(s.date + "T12:00:00")) / 86400000;
      if (age >= -1 && age < 7) { a7 += r.aeL; m7 += r.eccentric; c7++; }
      else if (age >= 7 && age < 14) { a14 += r.aeL; m14 += r.eccentric; }
    });
    $("r7a").textContent = Math.round(a7);
    $("r7m").textContent = Math.round(m7);
    $("p7a").textContent = a14 ? Math.round(a14) : "—";
    $("p7m").textContent = m14 ? Math.round(m14) : "—";
    $("r7an").textContent = c7 + (c7 === 1 ? " session" : " sessions");
    $("r7mn").textContent = m7 > 0 ? (m7 / 100).toFixed(1) + "× canonical bout" : "no descent logged";
  }

  function renderCorrelations(p) {
    var ePairs = [], aPairs = [];
    S.liveSessions(doc).forEach(function (s) {
      var r = LM.evaluateSession(s, p);
      if (s.soreness != null) ePairs.push([r.eccentric, s.soreness]);
      if (s.rpe != null) aPairs.push([r.aeL, s.rpe]);
    });
    setCorr("cSore", "cSoreN", S.correlate(ePairs), ePairs.length);
    setCorr("cRpe", "cRpeN", S.correlate(aPairs), aPairs.length);
  }
  function setCorr(vId, nId, r, n) {
    if (r == null || n < 5) {
      $(vId).textContent = "—";
      $(nId).textContent = n + " of 5 scored sessions";
      return;
    }
    $(vId).textContent = "r = " + r.toFixed(2);
    var strength = Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : "weak";
    $(nId).textContent = strength + ", n = " + n;
  }

  // --------------------------------------------------------------- mutations ---

  function commitSession() {
    var s = readSessionForm();
    if (!(s.durationMin > 0) || !(s.avgHr > 0)) {
      note("Duration and average heart rate are required.", "bad");
      return;
    }
    var idx = -1;
    doc.sessions.forEach(function (x, i) { if (x.id === s.id) idx = i; });
    if (idx >= 0) doc.sessions[idx] = s; else doc.sessions.push(s);
    doc.rev += 1;
    doc.updatedAt = S.now();
    dirty = true;
    var wasEdit = !!editingId;
    clearForm();
    persist();
    render();
    note(wasEdit ? "Updated " + s.date + "." :
      "Logged " + s.date + " — " + S.liveSessions(doc).length + " sessions stored.", "ok");
    pushRemote(wasEdit ? "edit" : "new session");
  }

  function beginEdit(id) {
    var found = null;
    doc.sessions.forEach(function (s) { if (s.id === id) found = s; });
    if (!found) return;
    editingId = id;
    writeSessionForm(found);
    setEditMode();
    refreshLive();
    render();
    note("Editing " + found.date + ". Add soreness, then Update.", "");
    $("entry").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function removeSession(id) {
    doc.sessions.forEach(function (s) {
      if (s.id === id) { s.deletedAt = S.now(); s.editedAt = S.now(); }
    });
    doc.rev += 1;
    doc.updatedAt = S.now();
    dirty = true;
    if (editingId === id) clearForm();
    persist();
    render();
    note("Deleted. A tombstone is kept so the delete survives syncing.", "ok");
    pushRemote("delete");
  }

  // -------------------------------------------------------------------- csv ---

  function csv() { return S.toCSV(doc, LM.evaluateSession); }

  function downloadCSV() {
    var blob = new Blob([csv()], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ultra-load-log-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    note("CSV downloaded — " + S.liveSessions(doc).length + " sessions.", "ok");
  }

  function downloadJSON() {
    var blob = new Blob([JSON.stringify(S.pack(doc), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ultra-load-bin-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    note("Raw bin JSON downloaded — paste this into JSONBin to restore.", "ok");
  }

  // ------------------------------------------------------------------- wire ---

  function init() {
    clearForm();

    var saved = S.loadLocal();
    if (saved) {
      doc = saved.doc;
      config = { binId: (saved.config.binId || ""), accessKey: (saved.config.accessKey || "") };
      dirty = saved.dirty;
      $("binId").value = config.binId;
      $("accessKey").value = config.accessKey;
      writeProfileForm(doc.profile);
    }

    refreshLive();
    render();

    // Pull once on load when configured, so a new device fills itself in.
    if (S.configured(config)) {
      syncNote("Checking the bin…", "");
      pullRemote();
    } else {
      syncNote("Running local-only. Configure a bin below for cross-device history.", "");
    }

    document.addEventListener("input", function (ev) {
      var t = ev.target;
      if (t.closest("#logBody") || t.closest("#weekBody")) return;
      if (t.id === "binId" || t.id === "accessKey") {
        config.binId = $("binId").value.trim();
        config.accessKey = $("accessKey").value.trim();
        S.saveLocal(doc, config, dirty);
        renderSyncState();
        return;
      }
      refreshLive();
      persist();
      render();
    });
    document.addEventListener("change", function (ev) {
      if (ev.target.closest("#logBody") || ev.target.closest("#weekBody")) return;
      refreshLive();
      persist();
      render();
    });

    $("save").addEventListener("click", commitSession);
    $("cancelEdit").addEventListener("click", function () {
      clearForm(); refreshLive(); render(); note("Edit cancelled.", "");
    });
    $("dlCsv").addEventListener("click", downloadCSV);
    $("dlJson").addEventListener("click", downloadJSON);
    $("copyCsv").addEventListener("click", function () {
      var txt = csv();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(
          function () { note("CSV copied to clipboard.", "ok"); },
          function () { note("Clipboard blocked — use Download CSV.", "bad"); });
      } else { note("Clipboard unavailable — use Download CSV.", "bad"); }
    });
    $("syncNow").addEventListener("click", function () { pushRemote("manually"); });
    $("pullNow").addEventListener("click", pullRemote);
    $("archive").addEventListener("click", function () {
      var cutoff = ($("archiveDate").value || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
        syncNote("Enter a cutoff date first.", "bad"); return;
      }
      var before = S.liveSessions(doc).length;
      doc = S.archiveBefore(doc, cutoff);
      var after = S.liveSessions(doc).length;
      dirty = true;
      persist();
      render();
      syncNote("Removed " + (before - after) + " session(s) before " + cutoff +
               ". Press Sync to write the smaller bin.", "ok");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
