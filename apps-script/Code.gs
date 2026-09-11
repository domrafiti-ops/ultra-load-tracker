/**
 * Google Apps Script backend for the Two-Channel Ultra Load Tracker.
 *
 * Paste this into Extensions > Apps Script on the Google Sheet you want to log
 * into, then deploy as a Web App. Full instructions: docs/SHEETS-SETUP.md
 *
 * This receives one JSON session per POST and appends it as a row. It is
 * idempotent on `id`: re-sending the same session updates the existing row
 * instead of duplicating it, so the app's "Push unsynced" button is safe to
 * press repeatedly.
 */

var SHEET_NAME = 'sessions';

var HEADERS = [
  'date',                    // A
  'label',                   // B
  'duration_min',            // C
  'avg_hr',                  // D
  'distance_km',             // E
  'ascent_m',                // F
  'descent_m',               // G
  'pack_kg',                 // H
  'descent_min',             // I
  'climb_min',               // J
  'cadence_spm',             // K
  'rpe',                     // L
  'soreness',                // M
  'ael_au',                  // N
  'ecc_au',                  // O
  'cyc_au',                  // P
  'mean_descent_grade_pct',  // Q
  'pct_hrr',                 // R
  'logged_at',               // S
  'id'                       // T
];

/** Entry point for the tracker's POST. */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var payload = JSON.parse(e.postData.contents);
    var sheet = getOrCreateSheet_();
    upsertRow_(sheet, payload);
    return json_({ ok: true, id: payload.id });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/** Health check — open the /exec URL in a browser to confirm the deployment. */
function doGet() {
  var sheet = getOrCreateSheet_();
  return json_({
    ok: true,
    sheet: SHEET_NAME,
    rows: Math.max(sheet.getLastRow() - 1, 0),
    message: 'Ultra Load Tracker endpoint is live. POST sessions here.'
  });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Append, or overwrite in place when this id has been seen before. */
function upsertRow_(sheet, payload) {
  var row = HEADERS.map(function (h) {
    var v = payload[h];
    return (v === undefined || v === null) ? '' : v;
  });

  var idCol = HEADERS.indexOf('id') + 1;
  var lastRow = sheet.getLastRow();
  if (payload.id && lastRow > 1) {
    var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(payload.id)) {
        sheet.getRange(i + 2, 1, 1, HEADERS.length).setValues([row]);
        return;
      }
    }
  }
  sheet.appendRow(row);
}

/**
 * Optional: run once from the Apps Script editor to add a derived-metrics
 * sheet with rolling loads and the two calibration correlations.
 * Formulas are live — they update as new rows arrive.
 */
function buildAnalysisSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = 'analysis';
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();

  sh.getRange('A1').setValue('Two-Channel Load — derived metrics').setFontWeight('bold');
  sh.getRange('A2').setValue('Formulas read the "sessions" sheet directly and update live.');

  var rows = [
    ['Metric', 'Value', 'Reading'],
    ['Sessions logged',
      '=COUNTA(sessions!A2:A)', 'total rows'],
    ['AeL — last 7 days',
      '=SUMIFS(sessions!N:N,sessions!A:A,">="&TODAY()-6,sessions!A:A,"<="&TODAY())', 'aerobic dose'],
    ['Ê — last 7 days',
      '=SUMIFS(sessions!O:O,sessions!A:A,">="&TODAY()-6,sessions!A:A,"<="&TODAY())', 'eccentric dose'],
    ['AeL — days 8-14',
      '=SUMIFS(sessions!N:N,sessions!A:A,">="&TODAY()-13,sessions!A:A,"<="&TODAY()-7)', 'prior week'],
    ['Ê — days 8-14',
      '=SUMIFS(sessions!O:O,sessions!A:A,">="&TODAY()-13,sessions!A:A,"<="&TODAY()-7)', 'prior week'],
    ['Ê in canonical bouts, last 7d',
      '=IFERROR(B4/100,"")', 'x the reference damaging protocol'],
    ['Ê vs next-day soreness',
      '=IFERROR(CORREL(FILTER(sessions!O2:O,sessions!M2:M<>""),FILTER(sessions!M2:M,sessions!M2:M<>"")),"need 3+ scored")',
      'strong positive = eccentric channel is tracking your tissue response'],
    ['AeL vs RPE',
      '=IFERROR(CORREL(FILTER(sessions!N2:N,sessions!L2:L<>""),FILTER(sessions!L2:L,sessions!L2:L<>"")),"need 3+ scored")',
      'strong positive = aerobic channel is tracking perceived effort'],
    ['Mean divergence Ê / AeL',
      '=IFERROR(AVERAGE(FILTER(sessions!O2:O/sessions!N2:N,sessions!N2:N>0)),"")',
      'high = descent-dominant training; low = flat/aerobic-dominant']
  ];
  sh.getRange(4, 1, rows.length, 3).setValues(rows);
  sh.getRange(4, 1, 1, 3).setFontWeight('bold');
  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(3, 420);
}
