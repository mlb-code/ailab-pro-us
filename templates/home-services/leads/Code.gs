/**
 * {{BUSINESS_NAME}} — website lead form → Google Sheet + email to the owner.
 * Home-services website template (US). Google Apps Script, runs in the client's (or our) Google account.
 *
 * One-time setup (README §8 has the click-by-click version):
 * 1. Create a Google Sheet "Website leads – {{BUSINESS_NAME}}". Copy its ID (between /d/ and /edit) into SHEET_ID.
 * 2. Put the owner's email in NOTIFY_EMAIL (comma-separate for more than one) and the IANA time zone in TIME_ZONE.
 * 3. In the Sheet: Extensions → Apps Script → replace everything with this file → Save.
 * 4. Select setupSheet → Run → approve permissions (Advanced → Go to … → Allow).
 * 5. Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy.
 * 6. Copy the Web app URL (ends in /exec) into content.json → business.leads_url, rebuild the site.
 * After editing this file later: Deploy → Manage deployments → Edit → Version: New version (same URL).
 */

const SHEET_ID = '{{SHEET_ID}}';
const SHEET_TAB_NAME = 'Leads';
const NOTIFY_EMAIL = '{{CLIENT_EMAIL}}';
const BUSINESS_NAME = '{{BUSINESS_NAME}}';
const TIME_ZONE = 'America/Chicago';

const FIELDS = ['name', 'phone', 'zip', 'email', 'service', 'urgency', 'contact_pref', 'message', 'consent', 'source'];
const HEADERS = ['Received', 'Name', 'Phone', 'ZIP', 'Email', 'Service', 'How soon', 'Contact by', 'Message',
                 'Consent to call/text', 'Page', 'Status', 'Notes'];

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.website) return json_({ success: true });                    // honeypot: bots fill hidden fields
    const digits = String(data.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (!data.name || digits.length !== 10) return json_({ success: false, error: 'missing name or phone' });
    if (!/^\d{5}(-\d{4})?$/.test(String(data.zip || '').trim())) return json_({ success: false, error: 'bad zip' });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = sheet_();
      const row = [new Date()].concat(FIELDS.map(function (k) {
        let v = data[k] === undefined || data[k] === null ? '' : String(data[k]).slice(0, 1000);
        if (k === 'phone') v = fmtPhone_(digits);
        if (k === 'consent') v = v ? 'yes' : 'no';
        if (/^[=+\-@]/.test(v)) v = "'" + v;                            // no formula injection into the Sheet
        return v;
      })).concat(['New', '']);
      sheet.appendRow(row);
    } finally {
      lock.releaseLock();
    }
    notify_(data, digits);
    return json_({ success: true });
  } catch (err) {
    console.error(err);
    return json_({ success: false, error: 'server error' });
  }
}

function notify_(d, digits) {
  try {
    const urgent = /emergency/i.test(d.urgency || '');
    const subject = (urgent ? 'URGENT – ' : '') + 'New website lead: ' + (d.name || 'no name') +
                    (d.service ? ' · ' + d.service : '') + (d.zip ? ' · ' + d.zip : '');
    const rows = [['Name', d.name], ['Phone', fmtPhone_(digits)], ['ZIP', d.zip], ['Email', d.email],
                  ['Service', d.service], ['How soon', d.urgency], ['Contact by', d.contact_pref],
                  ['Message', d.message], ['Consent to call/text', d.consent ? 'yes' : 'no'], ['Page', d.source]];
    const trs = rows.map(function (r) {
      return '<tr><td style="padding:8px 12px;font-weight:700;background:#f5f1ea;border:1px solid #e3dccf">' + r[0] +
             '</td><td style="padding:8px 12px;border:1px solid #e3dccf">' + esc_(r[1] || '—') + '</td></tr>';
    }).join('');
    const tel = '+1' + digits;
    const html =
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1d1b18">' +
      '<h2 style="margin:0 0 12px">' + 'New lead from your website</h2>' +
      '<table style="border-collapse:collapse;width:100%;font-size:15px">' + trs + '</table>' +
      '<p style="margin:18px 0"><a href="tel:' + tel + '" style="background:#AE3A0B;color:#fff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700">Call back</a> ' +
      '&nbsp;<a href="sms:' + tel + '" style="background:#0B5F80;color:#fff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700">Text back</a></p>' +
      '<p style="color:#777;font-size:12px">All leads: https://docs.google.com/spreadsheets/d/' + SHEET_ID + '</p></div>';
    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, htmlBody: html, name: BUSINESS_NAME + ' website',
                        replyTo: d.email && /@/.test(d.email) ? d.email : NOTIFY_EMAIL });
  } catch (err) {
    console.error('email failed: ' + err);
  }
}

function sheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(SHEET_TAB_NAME) || ss.getSheets()[0];
}

function fmtPhone_(d) {
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d;
}

function esc_(v) {
  return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(BUSINESS_NAME + ' leads endpoint is live.').setMimeType(ContentService.MimeType.TEXT);
}

/** Run once by hand: creates the "Leads" tab, headers, widths, time zone. Safe to re-run. */
function setupSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ss.setSpreadsheetTimeZone(TIME_ZONE);
  let sheet = ss.getSheetByName(SHEET_TAB_NAME);
  if (!sheet) {
    const first = ss.getSheets()[0];
    if (first && first.getLastRow() <= 1) { first.setName(SHEET_TAB_NAME); sheet = first; }
    else sheet = ss.insertSheet(SHEET_TAB_NAME);
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
       .setFontWeight('bold').setBackground('#1D1B18').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  [150, 150, 130, 70, 190, 170, 120, 100, 280, 120, 120, 90, 220].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd h:mm am/pm');
  const status = SpreadsheetApp.newDataValidation().requireValueInList(['New', 'Called', 'Booked', 'Not a fit'], true).build();
  sheet.getRange(2, 12, sheet.getMaxRows() - 1, 1).setDataValidation(status);
  console.log('Ready: ' + ss.getUrl());
}

/** Optional self-test from the editor: appends a fake row and sends the email. Delete the row afterwards. */
function testLead() {
  doPost({ postData: { contents: JSON.stringify({ name: 'Test Lead', phone: '(713) 555-0199', zip: '77005',
    service: 'AC repair', urgency: 'This week', contact_pref: 'Text me', message: 'Test from Apps Script',
    consent: 'yes', source: '/contact/' }) } });
}
