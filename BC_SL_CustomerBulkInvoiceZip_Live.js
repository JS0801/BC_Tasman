/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Live customer invoice bulk-printer UI.
 *
 * Opens from the Customer record, lists invoices flagged To Be Printed, then lets the
 * browser request one PDF per selected invoice from Tasman_SL_Print_invoice_PDF_live_api.js
 * using ?mode=bulkPdf&recId=<invoiceId>. The browser assembles a ZIP locally, then posts
 * the successfully generated invoice ids back here so this Suitelet can save a CSV file to
 * the file cabinet and launch a Scheduled Script that submits the configured CSV import to
 * clear To Be Printed.
 */

define(['N/search', 'N/url', 'N/file', 'N/task'], function (search, url, file, task) {

  // Update these if your NetSuite script/deployment ids differ.
  var PDF_SUITELET_SCRIPT_ID = 'customscript_bc_sl_inv_pdf_printv2';
  var PDF_SUITELET_DEPLOYMENT_ID = 'customdeploy1';

  var DEFAULT_CONCURRENCY = 2;
  var MAX_INVOICES_PER_RUN = 100;
  var CSV_IMPORT_FOLDER_ID = 2654;
  var CSV_IMPORT_SCHEDULED_SCRIPT_ID = 'customscript_bc_sch_submit_csv_import';
  var CSV_IMPORT_SCHEDULED_DEPLOYMENT_ID = 'customdeploy_bc_sch_submit_csv_import';

  // Set this to the saved CSV import map id that updates Invoice records by Internal ID
  // and maps "To Be Printed" to the native To Be Printed checkbox.
  var CSV_IMPORT_MAPPING_ID = '189';
  var PARAM_CSV_FILE_ID = 'custscript_bc_inv_csv_file_id';
  var PARAM_CSV_IMPORT_MAPPING_ID = 'custscript_bc_inv_csv_mapping_id';
  var PARAM_CSV_IMPORT_TASK_NAME = 'custscript_bc_inv_csv_task_name';

  function onRequest(context) {
    var request = context.request;
    var response = context.response;

    var custId = request.parameters.custId || '';
    var customerName = request.parameters.customerName || '';
    var action = request.parameters.action || '';

    if (request.method === 'GET') {
      if (action === 'list') {
        writeJson(response, buildInvoicePayload(custId, customerName));
        return;
      }

      writeHtml(response, buildHtml(buildInvoicePayload(custId, customerName)));
      return;
    }

    if (request.method === 'POST' && action === 'submitCsvImport') {
      submitCsvImportFromRequest(request, response, custId, customerName);
      return;
    }

    writeJson(response, {
      ok: false,
      error: 'Unsupported request.'
    });
  }

  function buildInvoicePayload(custId, customerNameParam) {
    if (!custId) {
      return {
        ok: false,
        error: 'Missing custId parameter.',
        custId: '',
        customerName: '',
        invoices: []
      };
    }

    try {
      var customerName = normalizeCustomerName(customerNameParam) || getCustomerName(custId);
      var invoiceResult = getInvoicesToPrint(custId);

      return {
        ok: true,
        custId: custId,
        customerName: customerName,
        invoices: invoiceResult.invoices,
        totalAvailable: invoiceResult.totalAvailable,
        maxInvoicesPerRun: MAX_INVOICES_PER_RUN,
        generatedAt: new Date().toString(),
        pdfBaseUrl: url.resolveScript({
          scriptId: PDF_SUITELET_SCRIPT_ID,
          deploymentId: PDF_SUITELET_DEPLOYMENT_ID
        }),
        defaultConcurrency: DEFAULT_CONCURRENCY
      };
    } catch (e) {
      log.error('Could not build invoice payload for customer ' + custId, e);
      return {
        ok: false,
        error: e.message || String(e),
        custId: custId,
        customerName: '',
        invoices: []
      };
    }
  }

  function normalizeCustomerName(customerName) {
    return String(customerName || '').replace(/^\s+|\s+$/g, '');
  }

  function getCustomerName(custId) {
    var fallback = 'Customer ' + custId;

    try {
      var values = search.lookupFields({
        type: 'customer',
        id: custId,
        columns: ['companyname', 'altname', 'entityid']
      });

      return values.companyname || values.altname || values.entityid || fallback;
    } catch (e) {
      log.debug('Customer name lookup failed for ' + custId, e);
      return fallback;
    }
  }

  function getInvoicesToPrint(custId) {
    var invoices = [];

    var invSearch = search.create({
      type: search.Type.INVOICE,
      filters: [
        ['entity', 'anyof', custId],
        'AND', ['mainline', 'is', 'T'],
        'AND', ['tobeprinted', 'is', 'T'],
        'AND', ['amountremaining', 'greaterthan', '0.00']
      ],
      columns: [
        search.createColumn({ name: 'tranid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'trandate' }),
        search.createColumn({ name: 'duedate' }),
        search.createColumn({ name: 'amount' }),
        search.createColumn({ name: 'memo' }),
        search.createColumn({ name: 'amountremaining' }),
        search.createColumn({
  name: 'custentity4',
  join: 'jobMain',
  label: 'Project Contact'
}),
search.createColumn({
  name: 'custentity26',
  join: 'jobMain',
  label: 'Site Name (GoFormz)'
})
      ]
    });

    var pagedData = invSearch.runPaged({
      pageSize: MAX_INVOICES_PER_RUN
    });

    if (pagedData.pageRanges.length) {
      var firstPage = pagedData.fetch({
        index: 0
      });

      firstPage.data.forEach(function (result) {

        var approverValue = result.getValue({
  name: 'custentity4',
  join: 'jobMain'
}) || '';

var jobNameValue = result.getValue({
  name: 'custentity26',
  join: 'jobMain'
}) || '';
        
        invoices.push({
          id: result.getValue({ name: 'internalid' }),
          tranid: result.getValue({ name: 'tranid' }) || '',
          trandate: result.getValue({ name: 'trandate' }) || '',
          duedate: result.getValue({ name: 'duedate' }) || '',
          amount: result.getValue({ name: 'amount' }) || '',
          memo: result.getValue({ name: 'memo' }) || '',
          amountremaining: result.getValue({ name: 'amountremaining' }) || '',          
          jobFirstWord: firstWord(jobNameValue),
          approverInitials: approverInitials(approverValue)
        });
      });
    }

    return {
      invoices: invoices,
      totalAvailable: pagedData.count
    };
  }


  function firstWord(value) {
  var text = String(value || '').replace(/^\s+|\s+$/g, '');
  if (!text) return '';

  return text.split(/\s+/)[0] || '';
}

function approverInitials(value) {
  var text = String(value || '').replace(/^\s+|\s+$/g, '');
  if (!text) return '';

  var match = /env\s*[-_:]\s*(.*)$/i.exec(text);
  var remainder = match ? match[1] : text;

  var rawWords = remainder.split(/[^A-Za-z]+/);
  var initials = '';

  for (var i = 0; i < rawWords.length; i++) {
    if (rawWords[i]) initials += rawWords[i].charAt(0).toUpperCase();
  }

  return initials;
}

  function submitCsvImportFromRequest(request, response, custId, customerNameParam) {
    try {
      var payload = JSON.parse(request.body || '{}');
      var invoiceIds = cleanInvoiceIds(payload.invoiceIds || []);

      if (!custId) throw new Error('Missing custId parameter.');
      if (!invoiceIds.length) throw new Error('No successful invoice ids were provided.');

      var customerName = normalizeCustomerName(payload.customerName) ||
        normalizeCustomerName(customerNameParam) ||
        getCustomerName(custId);
      var csvText = buildCsvText(invoiceIds);
      var csvName = buildCsvFileName(customerName);
      var csvFile = file.create({
        name: csvName,
        fileType: file.Type.CSV,
        contents: csvText,
        folder: CSV_IMPORT_FOLDER_ID
      });

      var fileId = csvFile.save();
      if (!CSV_IMPORT_MAPPING_ID) {
        writeJson(response, {
          ok: false,
          error: 'CSV file was saved as ' + csvName + ' (File ID ' + fileId + '), but CSV_IMPORT_MAPPING_ID is not configured on the Suitelet.',
          fileId: fileId,
          fileName: csvName,
          invoiceCount: invoiceIds.length
        });
        return;
      }

      var importTaskName = 'Clear To Be Printed - ' + customerName + ' - ' + buildDateStamp();
      var scheduledTask = task.create({
        taskType: task.TaskType.SCHEDULED_SCRIPT
      });

      scheduledTask.scriptId = CSV_IMPORT_SCHEDULED_SCRIPT_ID;
      scheduledTask.deploymentId = CSV_IMPORT_SCHEDULED_DEPLOYMENT_ID;
      scheduledTask.params = {};
      scheduledTask.params[PARAM_CSV_FILE_ID] = String(fileId);
      scheduledTask.params[PARAM_CSV_IMPORT_MAPPING_ID] = CSV_IMPORT_MAPPING_ID;
      scheduledTask.params[PARAM_CSV_IMPORT_TASK_NAME] = importTaskName;

      log.debug('scheduledTask', scheduledTask.params)

      var scheduledTaskId = scheduledTask.submit();

      writeJson(response, {
        ok: true,
        fileId: fileId,
        fileName: csvName,
        scheduledTaskId: scheduledTaskId,
        invoiceCount: invoiceIds.length
      });
    } catch (e) {
      log.error('CSV import submission failed', e);
      writeJson(response, {
        ok: false,
        error: e.message || String(e)
      });
    }
  }

  function cleanInvoiceIds(invoiceIds) {
    var cleaned = [];

    if (Object.prototype.toString.call(invoiceIds) !== '[object Array]') return cleaned;

    for (var i = 0; i < invoiceIds.length; i++) {
      var id = String(invoiceIds[i] || '').replace(/^\s+|\s+$/g, '');
      if (!/^\d+$/.test(id)) continue;
      if (cleaned.indexOf(id) === -1) cleaned.push(id);
    }

    return cleaned;
  }

  function buildCsvText(invoiceIds) {
    var lines = ['Internal ID,To Be Printed'];

    for (var i = 0; i < invoiceIds.length; i++) {
      lines.push(csvValue(invoiceIds[i]) + ',F');
    }

    return lines.join('\r\n') + '\r\n';
  }

  function buildCsvFileName(customerName) {
    return 'Clear_To_Be_Printed_' + sanitizeFileNamePart(customerName) + '_' + buildDateStamp() + '.csv';
  }

  function buildDateStamp() {
    var now = new Date();

    return now.getFullYear() + '-' +
      padTwo(now.getMonth() + 1) + '-' +
      padTwo(now.getDate()) + '_' +
      padTwo(now.getHours()) +
      padTwo(now.getMinutes()) +
      padTwo(now.getSeconds());
  }

  function padTwo(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function csvValue(value) {
    value = String(value === null || value === undefined ? '' : value);
    if (/[",\r\n]/.test(value)) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  function sanitizeFileNamePart(value) {
    return String(value || 'Customer')
      .replace(/[\/\\:\*\?"<>\|\r\n\t]/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\s+/g, '_') || 'Customer';
  }

  function writeJson(response, payload) {
    response.addHeader({
      name: 'Content-Type',
      value: 'application/json; charset=UTF-8'
    });
    response.write(JSON.stringify(payload));
  }

  function writeHtml(response, html) {
    response.addHeader({
      name: 'Content-Type',
      value: 'text/html; charset=UTF-8'
    });
    response.write(html);
  }

  function buildHtml(payload) {
    var config = JSON.stringify(payload)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');

    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Bulk Invoice PDF Export</title>',
      '<style>',
      ':root { color-scheme: light; --bg: #f6f7f9; --panel: #ffffff; --ink: #17202a; --muted: #667085; --line: #d9dee7; --accent: #0f766e; --accent-strong: #115e59; --danger: #b42318; --warn: #9a6700; --ok: #067647; --soft: #edf7f5; }',
      '* { box-sizing: border-box; }',
      'body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
      '.app { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 36px; }',
      '.top { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; margin-bottom: 18px; }',
      'h1 { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 720; letter-spacing: 0; }',
      '.sub { color: var(--muted); margin-top: 4px; }',
      '.toolbar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }',
      'button { height: 36px; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 0 12px; font: inherit; }',
      'button { cursor: pointer; font-weight: 650; }',
      'button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }',
      'button.primary:hover { background: var(--accent-strong); }',
      'button:disabled { opacity: .5; cursor: default; }',
      '.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }',
      '.metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }',
      '.metric .label { color: var(--muted); font-size: 12px; }',
      '.metric .value { margin-top: 4px; font-size: 22px; font-weight: 760; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.progressPanel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 12px; }',
      '.statusLine { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }',
      '.statusLine strong { font-weight: 720; }',
      '.bar { height: 10px; border-radius: 999px; overflow: hidden; background: #e8edf3; }',
      '.bar > span { display: block; width: 0%; height: 100%; background: var(--accent); transition: width .18s ease; }',
      '.notice { display: none; margin: 10px 0 0; padding: 10px 12px; border: 1px solid #b7ddd8; background: var(--soft); color: #164e48; border-radius: 6px; }',
      '.notice.show { display: block; }',
      '.tableWrap { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }',
      'table { width: 100%; border-collapse: collapse; table-layout: fixed; }',
      'th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      'th { color: var(--muted); font-size: 12px; font-weight: 700; background: #fbfcfe; }',
      'tbody tr:last-child td { border-bottom: 0; }',
      '.c-select { width: 46px; text-align: center; }',
      '.c-date { width: 104px; }',
      '.c-due { width: 104px; }',
      '.c-amount { width: 118px; text-align: right; }',
      '.c-memo { width: 210px; }',
      '.c-status { width: 130px; }',
      'input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }',
      '.pill { display: inline-flex; align-items: center; max-width: 100%; min-height: 24px; border-radius: 999px; padding: 3px 9px; background: #eef2f6; color: #475467; font-size: 12px; font-weight: 680; }',
      '.pill.queued { background: #eef2f6; color: #475467; }',
      '.pill.working { background: #fff4cc; color: var(--warn); }',
      '.pill.done { background: #dcfae6; color: var(--ok); }',
      '.pill.failed { background: #fee4e2; color: var(--danger); }',
      '.pill.skipped { background: #f2f4f7; color: #667085; }',
      '.empty, .errorBox { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; color: var(--muted); }',
      '.errorBox { color: var(--danger); border-color: #fecdca; background: #fffbfa; }',
      '@media (max-width: 900px) { .c-memo, .c-amount { display: none; } }',
      '@media (max-width: 760px) { .app { width: min(100vw - 20px, 1180px); padding-top: 18px; } .top { display: block; } .toolbar { justify-content: flex-start; margin-top: 12px; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } th, td { padding: 9px 8px; } .c-date, .c-due { display: none; } .c-select { width: 40px; } .c-status { width: 112px; } }',
      '</style>',
      '</head>',
      '<body>',
      '<main class="app">',
      '<section class="top">',
      '<div>',
      '<h1>Bulk Invoice PDF Export</h1>',
      '<div class="sub" id="subtitle">' + escapeHtml(payload.customerName || ('Customer ' + (payload.custId || ''))) + '</div>',
      '</div>',
      '<div class="toolbar">',
      '<button id="refreshBtn" type="button">Refresh</button>',
      '<button id="startBtn" class="primary" type="button">Start Export</button>',
      '</div>',
      '</section>',
      '<section id="errorBox" class="errorBox" style="display:none"></section>',
      '<section class="summary">',
      '<div class="metric"><div class="label">Queued</div><div class="value" id="queuedCount">0</div></div>',
      '<div class="metric"><div class="label">Generated</div><div class="value" id="successCount">0</div></div>',
      '<div class="metric"><div class="label">Failed</div><div class="value" id="failedCount">0</div></div>',
      '<div class="metric"><div class="label">Total</div><div class="value" id="totalCount">0</div></div>',
      '</section>',
      '<section class="progressPanel">',
      '<div class="statusLine"><strong id="stateText">Ready</strong><span id="detailText">0 / 0</span></div>',
      '<div class="bar"><span id="progressBar"></span></div>',
      '<div class="notice" id="notice"></div>',
      '</section>',
      '<section id="emptyBox" class="empty" style="display:none">No invoices with remaining amount greater than zero are currently flagged To Be Printed for this customer.</section>',
      '<section class="tableWrap" id="tableWrap">',
      '<table>',
      '<thead><tr><th class="c-select"><input type="checkbox" id="selectAll" checked aria-label="Select all invoices"></th><th>Invoice #</th><th class="c-date">Date</th><th class="c-due">Due Date</th><th class="c-amount">Amount</th><th class="c-memo">Memo</th><th class="c-amount">Remaining</th><th class="c-status">Status</th></tr></thead>',
      '<tbody id="invoiceRows"></tbody>',
      '</table>',
      '</section>',
      '</main>',
      '<script>window.BULK_INVOICE_CONFIG = ' + config + ';</script>',
      '<script>(' + browserClient.toString() + ')();</script>',
      '</body>',
      '</html>'
    ].join('\n');
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function browserClient() {
    'use strict';

    var config = window.BULK_INVOICE_CONFIG || {};
    var invoices = config.invoices || [];
    var state = {
      started: false,
      active: 0,
      nextIndex: 0,
      completed: 0,
      selectedInvoices: [],
      successes: [],
      failures: [],
      zipEntries: [],
      csvImport: null,
      zipDownloaded: false,
      finalizing: false,
      done: false
    };

    var rowById = {};
    var usedNames = {};
    var encoder = new TextEncoder();
    var crcTable = null;

    var els = {};

    function init() {
      els.startBtn = document.getElementById('startBtn');
      els.refreshBtn = document.getElementById('refreshBtn');
      els.selectAll = document.getElementById('selectAll');
      els.rows = document.getElementById('invoiceRows');
      els.tableWrap = document.getElementById('tableWrap');
      els.emptyBox = document.getElementById('emptyBox');
      els.errorBox = document.getElementById('errorBox');
      els.notice = document.getElementById('notice');
      els.stateText = document.getElementById('stateText');
      els.detailText = document.getElementById('detailText');
      els.progressBar = document.getElementById('progressBar');
      els.queuedCount = document.getElementById('queuedCount');
      els.successCount = document.getElementById('successCount');
      els.failedCount = document.getElementById('failedCount');
      els.totalCount = document.getElementById('totalCount');
      els.subtitle = document.getElementById('subtitle');

      els.startBtn.addEventListener('click', start);
      els.refreshBtn.addEventListener('click', refreshList);
      els.selectAll.addEventListener('change', handleSelectAll);

      if (!config.ok) {
        showError(config.error || 'Could not load invoices.');
      }

      renderRows();
      updateDashboard('Ready');
    }

    function renderRows() {
      rowById = {};
      usedNames = {};
      els.rows.textContent = '';

      for (var i = 0; i < invoices.length; i++) {
        var inv = invoices[i];
        var tr = document.createElement('tr');
        tr.setAttribute('data-id', inv.id);

        var selectCell = document.createElement('td');
        selectCell.className = 'c-select';
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'invoiceSelect';
        checkbox.setAttribute('data-id', inv.id);
        checkbox.setAttribute('aria-label', 'Select invoice ' + (inv.tranid || inv.id));
        checkbox.checked = true;
        checkbox.addEventListener('change', handleInvoiceCheckboxChange);
        selectCell.appendChild(checkbox);
        tr.appendChild(selectCell);

        tr.appendChild(cell(inv.tranid || 'Invoice ' + inv.id));
        tr.appendChild(cell(inv.trandate || '', 'c-date'));
        tr.appendChild(cell(inv.duedate || '', 'c-due'));
        tr.appendChild(cell(inv.amount || '', 'c-amount'));
        tr.appendChild(cell(inv.memo || '', 'c-memo'));
        tr.appendChild(cell(inv.amountremaining || '', 'c-amount'));

        var statusCell = document.createElement('td');
        statusCell.className = 'c-status';
        statusCell.appendChild(statusPill('Queued', 'queued'));
        tr.appendChild(statusCell);

        els.rows.appendChild(tr);
        rowById[inv.id] = tr;
      }

      var hasRows = invoices.length > 0;
      els.tableWrap.style.display = hasRows ? '' : 'none';
      els.emptyBox.style.display = hasRows ? 'none' : '';
      els.startBtn.disabled = !hasRows || !config.ok;
      updateSelectAll();
    }

    function cell(text, className) {
      var td = document.createElement('td');
      if (className) td.className = className;
      td.textContent = text === null || text === undefined ? '' : String(text);
      return td;
    }

    function statusPill(text, kind) {
      var span = document.createElement('span');
      span.className = 'pill ' + kind;
      span.textContent = text;
      return span;
    }

    function handleSelectAll() {
      if (state.started) return;

      var checked = els.selectAll.checked;
      var boxes = getInvoiceCheckboxes();
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = checked;
      }

      updateSelectAll();
      updateDashboard('Ready');
    }

    function handleInvoiceCheckboxChange() {
      if (state.started) return;

      updateSelectAll();
      updateDashboard('Ready');
    }

    function getInvoiceCheckboxes() {
      return els.rows.querySelectorAll('input.invoiceSelect');
    }

    function getSelectedInvoices() {
      var selectedById = {};
      var boxes = getInvoiceCheckboxes();
      var selected = [];

      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) selectedById[boxes[i].getAttribute('data-id')] = true;
      }

      for (var j = 0; j < invoices.length; j++) {
        if (selectedById[invoices[j].id]) selected.push(invoices[j]);
      }

      return selected;
    }

    function updateSelectAll() {
      if (!els.selectAll) return;

      var boxes = getInvoiceCheckboxes();
      var checkedCount = 0;

      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked) checkedCount++;
      }

      els.selectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
      els.selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    }

    function setSelectionDisabled(disabled) {
      var boxes = getInvoiceCheckboxes();

      for (var i = 0; i < boxes.length; i++) {
        boxes[i].disabled = disabled;
      }

      if (els.selectAll) els.selectAll.disabled = disabled;
    }

    function start() {
      if (state.started || !invoices.length) return;

      var selected = getSelectedInvoices();
      if (!selected.length) {
        showNotice('Select at least one invoice to export.');
        return;
      }

      state.started = true;
      state.active = 0;
      state.nextIndex = 0;
      state.completed = 0;
      state.selectedInvoices = selected;
      state.successes = [];
      state.failures = [];
      state.zipEntries = [];
      state.csvImport = null;
      state.zipDownloaded = false;
      state.finalizing = false;
      state.done = false;
      usedNames = {};

      els.startBtn.disabled = true;
      els.refreshBtn.disabled = true;
      setSelectionDisabled(true);
      hideNotice();
      resetStatuses();
      updateDashboard('Running');
      pump();
    }

    function resetStatuses() {
      var selectedById = {};

      for (var i = 0; i < state.selectedInvoices.length; i++) {
        selectedById[state.selectedInvoices[i].id] = true;
      }

      for (var i = 0; i < invoices.length; i++) {
        if (selectedById[invoices[i].id]) {
          setRowStatus(invoices[i], 'Queued', 'queued');
        } else {
          setRowStatus(invoices[i], 'Skipped', 'skipped');
        }
      }
    }

    function pump() {
      if (state.finalizing || state.done) return;

      var concurrency = Math.max(1, Number(config.defaultConcurrency || 2));

      while (state.active < concurrency && state.nextIndex < state.selectedInvoices.length) {
        runInvoice(state.selectedInvoices[state.nextIndex]);
        state.nextIndex++;
      }

      if (state.active === 0 && state.nextIndex >= state.selectedInvoices.length) {
        finalizeZip();
      }
    }

    function runInvoice(inv) {
      state.active++;
      setRowStatus(inv, 'Rendering', 'working');
      updateDashboard('Running');

      fetchInvoicePdf(inv).then(function (pdf) {
        state.successes.push({
          id: inv.id,
          tranid: inv.tranid,
          fileName: pdf.fileName
        });
        state.zipEntries.push({
          name: pdf.fileName,
          blob: pdf.blob
        });
        setRowStatus(inv, 'Generated', 'done');
      }).catch(function (error) {
        state.failures.push({
          id: inv.id,
          tranid: inv.tranid,
          message: error.message || String(error)
        });
        setRowStatus(inv, 'Failed', 'failed');
      }).then(function () {
        state.active--;
        state.completed++;
        updateDashboard('Running');
        pump();
      });
    }

    function fetchInvoicePdf(inv) {
      var requestUrl = addParams(config.pdfBaseUrl, {
        mode: 'bulkPdf',
        recId: inv.id,
        ts: String(Date.now())
      });

      return fetch(requestUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      }).then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }

        return response.blob().then(function (blob) {
          return assertPdfBlob(blob).then(function () {
            var fileName = buildInvoicePdfName(inv);
            fileName = uniqueFileName(fileName);

            return {
              fileName: fileName,
              blob: blob
            };
          });
        });
      });
    }

function buildInvoicePdfName(inv) {
  var invoicePart = cleanZipPart(inv.tranid || ('Invoice ' + inv.id));
  var jobPart = cleanZipPart(inv.jobFirstWord || '');
  var approverPart = cleanZipPart(inv.approverInitials || '');

  var name = invoicePart;

  if (jobPart && approverPart) {
    name += ' ' + jobPart + '_' + approverPart;
  } else if (jobPart) {
    name += ' ' + jobPart;
  } else if (approverPart) {
    name += ' _' + approverPart;
  }

  return name + '.pdf';
}

    function assertPdfBlob(blob) {
      if (!blob || !blob.size) {
        return Promise.reject(new Error('Empty PDF response'));
      }

      return blob.slice(0, 5).arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var looksLikePdf = bytes.length >= 5 &&
          bytes[0] === 37 &&
          bytes[1] === 80 &&
          bytes[2] === 68 &&
          bytes[3] === 70 &&
          bytes[4] === 45;

        if (!looksLikePdf) throw new Error('Response was not a PDF');
      });
    }

    function finalizeZip() {
      if (state.finalizing || state.done) return;

      state.finalizing = true;
      updateDashboard('Building ZIP');

      var entries = state.zipEntries.slice();

      if (!entries.length) {
        state.done = true;
        state.finalizing = false;
        showError('No PDFs were generated. The CSV import was not submitted.');
        updateDashboard('No PDFs generated');
        return;
      }

      createZipBlob(entries).then(function (zipBlob) {
        downloadBlob(zipBlob, buildZipName());
        state.zipDownloaded = true;
        updateDashboard('Launching CSV Import');
        return submitCsvImport();
      }).then(function (importResult) {
        state.csvImport = importResult;
        state.done = true;
        state.finalizing = false;
        updateDashboard('Done');
        showNotice('ZIP downloaded. Scheduled CSV import task ' + importResult.scheduledTaskId + ' launched for ' + importResult.invoiceCount + ' invoice(s). CSV file saved as ' + importResult.fileName + '.');
      }).catch(function (error) {
        state.finalizing = false;
        if (state.zipDownloaded) {
          showError('ZIP downloaded, but CSV import submission failed: ' + (error.message || String(error)));
          updateDashboard('CSV import failed');
        } else {
          showError('ZIP build failed: ' + (error.message || String(error)));
          updateDashboard('ZIP failed');
        }
      });
    }

    function submitCsvImport() {
      var invoiceIds = [];

      for (var i = 0; i < state.successes.length; i++) {
        invoiceIds.push(state.successes[i].id);
      }

      if (!invoiceIds.length) {
        return Promise.reject(new Error('No successful invoice ids to import'));
      }

      var importUrl = new URL(window.location.href);
      importUrl.searchParams.set('action', 'submitCsvImport');

      return fetch(importUrl.toString(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          custId: config.custId,
          customerName: config.customerName,
          invoiceIds: invoiceIds
        })
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }).then(function (payload) {
        if (!payload.ok) throw new Error(payload.error || 'CSV import was not submitted');
        return payload;
      });
    }

    function refreshList() {
      if (state.started) return;

      var refreshUrl = new URL(window.location.href);
      refreshUrl.searchParams.set('action', 'list');

      els.refreshBtn.disabled = true;
      updateDashboard('Refreshing');

      fetch(refreshUrl.toString(), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }).then(function (payload) {
        if (!payload.ok) throw new Error(payload.error || 'Could not refresh invoices');
        config = payload;
        invoices = payload.invoices || [];
        els.subtitle.textContent = payload.customerName || ('Customer ' + (payload.custId || ''));
        hideError();
        renderRows();
        updateDashboard('Ready');
      }).catch(function (error) {
        showError(error.message || String(error));
        updateDashboard('Refresh failed');
      }).then(function () {
        els.refreshBtn.disabled = false;
      });
    }

    function setRowStatus(inv, label, kind) {
      var row = rowById[inv.id];
      if (!row) return;

      var statusCell = row.cells[row.cells.length - 1];
      statusCell.textContent = '';
      statusCell.appendChild(statusPill(label, kind));
    }

    function updateDashboard(label) {
      var total = state.started ? state.selectedInvoices.length : getSelectedInvoices().length;
      var queued = state.started ? Math.max(0, total - state.completed - state.active) : total;
      var doneCount = state.successes.length;
      var failedCount = state.failures.length;
      var percent = total ? Math.round((state.completed / total) * 100) : 0;

      if (!state.started && els.startBtn) {
        els.startBtn.disabled = !config.ok || total === 0;
      }

      els.queuedCount.textContent = String(queued);
      els.successCount.textContent = String(doneCount);
      els.failedCount.textContent = String(failedCount);
      els.totalCount.textContent = String(total);
      els.stateText.textContent = label || 'Ready';
      els.detailText.textContent = state.completed + ' / ' + total;
      els.progressBar.style.width = percent + '%';
    }

    function showNotice(message) {
      els.notice.textContent = message;
      els.notice.classList.add('show');
    }

    function hideNotice() {
      els.notice.textContent = '';
      els.notice.classList.remove('show');
    }

    function showError(message) {
      els.errorBox.textContent = message;
      els.errorBox.style.display = '';
      els.startBtn.disabled = true;
    }

    function hideError() {
      els.errorBox.textContent = '';
      els.errorBox.style.display = 'none';
    }

    function addParams(baseUrl, params) {
      var joiner = baseUrl.indexOf('?') === -1 ? '?' : '&';
      var query = [];

      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key)) {
          query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        }
      }

      return baseUrl + joiner + query.join('&');
    }

    function fileNameFromHeader(header) {
      if (!header) return '';

      var utfMatch = /filename\*=UTF-8''([^;]+)/i.exec(header);
      if (utfMatch && utfMatch[1]) {
        try {
          return cleanFileName(decodeURIComponent(utfMatch[1]));
        } catch (e) {
          return cleanFileName(utfMatch[1]);
        }
      }

      var match = /filename="?([^";]+)"?/i.exec(header);
      return match && match[1] ? cleanFileName(match[1]) : '';
    }

    function fallbackPdfName(inv) {
      return cleanFileName((inv.tranid || 'Invoice_' + inv.id) + '.pdf');
    }

    function cleanFileName(name) {
      name = String(name || 'invoice.pdf')
        .replace(/[\/\\:\*\?"<>\|\r\n\t]/g, ' ')
        .replace(/^\s+|\s+$/g, '')
        .replace(/\s{2,}/g, ' ');

      if (!/\.pdf$/i.test(name)) name += '.pdf';
      return name || 'invoice.pdf';
    }

    function uniqueFileName(name) {
      var clean = cleanFileName(name);
      var lower = clean.toLowerCase();

      if (!usedNames[lower]) {
        usedNames[lower] = 1;
        return clean;
      }

      usedNames[lower]++;
      var count = usedNames[lower];
      var dot = clean.lastIndexOf('.');
      var base = dot === -1 ? clean : clean.substring(0, dot);
      var ext = dot === -1 ? '' : clean.substring(dot);
      return base + '_' + count + ext;
    }

    function buildZipName() {
      var date = new Date();
      var stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
      return 'Invoices_' + cleanZipPart(config.customerName || ('Customer ' + config.custId)) + '_' + stamp + '.zip';
    }

    function cleanZipPart(value) {
      return String(value || '')
        .replace(/[\/\\:\*\?"<>\|\r\n\t]/g, ' ')
        .replace(/^\s+|\s+$/g, '')
        .replace(/\s+/g, '_') || 'Unknown';
    }

    function pad(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function csvValue(value) {
      value = String(value === null || value === undefined ? '' : value);
      if (/[",\r\n]/.test(value)) {
        return '"' + value.replace(/"/g, '""') + '"';
      }
      return value;
    }

    function downloadBlob(blob, fileName) {
      var objectUrl = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.setTimeout(function () {
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    }

    function createZipBlob(entries) {
      return normalizeZipEntries(entries).then(function (normalized) {
        var files = [];
        var offset = 0;
        var centralSize = 0;
        var now = dosDateTime(new Date());

        for (var i = 0; i < normalized.length; i++) {
          var entry = normalized[i];
          var localHeader = buildLocalHeader(entry, now);

          files.push({
            entry: entry,
            offset: offset,
            localHeader: localHeader
          });

          offset += localHeader.length + entry.data.length;
        }

        for (var c = 0; c < files.length; c++) {
          centralSize += buildCentralHeader(files[c], now).length;
        }

        var end = buildEndRecord(files.length, centralSize, offset);
        var totalSize = offset + centralSize + end.length;
        var zip = new Uint8Array(totalSize);
        var pointer = 0;

        for (var j = 0; j < files.length; j++) {
          pointer = appendBytes(zip, pointer, files[j].localHeader);
          pointer = appendBytes(zip, pointer, files[j].entry.data);
        }

        for (var k = 0; k < files.length; k++) {
          pointer = appendBytes(zip, pointer, buildCentralHeader(files[k], now));
        }

        appendBytes(zip, pointer, end);

        return new Blob([zip], { type: 'application/zip' });
      });
    }

    function normalizeZipEntries(entries) {
      var chain = Promise.resolve([]);

      entries.forEach(function (entry) {
        chain = chain.then(function (items) {
          return entryToBytes(entry).then(function (bytes) {
            var name = String(entry.name || 'file').replace(/^\/+/, '').replace(/[\\]/g, '/');
            if (!name) name = 'file';

            if (bytes.length > 0xffffffff) {
              throw new Error(name + ' is too large for standard ZIP');
            }

            items.push({
              name: name,
              nameBytes: encoder.encode(name),
              data: bytes,
              crc: crc32(bytes)
            });

            return items;
          });
        });
      });

      return chain;
    }

    function entryToBytes(entry) {
      if (entry.blob) {
        return entry.blob.arrayBuffer().then(function (buffer) {
          return new Uint8Array(buffer);
        });
      }

      if (entry.text !== undefined) {
        return Promise.resolve(encoder.encode(String(entry.text)));
      }

      if (entry.data) {
        return Promise.resolve(entry.data);
      }

      return Promise.resolve(new Uint8Array(0));
    }

    function buildLocalHeader(entry, stamp) {
      var header = new Uint8Array(30 + entry.nameBytes.length);
      writeU32(header, 0, 0x04034b50);
      writeU16(header, 4, 20);
      writeU16(header, 6, 0x0800);
      writeU16(header, 8, 0);
      writeU16(header, 10, stamp.time);
      writeU16(header, 12, stamp.date);
      writeU32(header, 14, entry.crc);
      writeU32(header, 18, entry.data.length);
      writeU32(header, 22, entry.data.length);
      writeU16(header, 26, entry.nameBytes.length);
      writeU16(header, 28, 0);
      header.set(entry.nameBytes, 30);
      return header;
    }

    function buildCentralHeader(file, stamp) {
      var entry = file.entry;
      var header = new Uint8Array(46 + entry.nameBytes.length);
      writeU32(header, 0, 0x02014b50);
      writeU16(header, 4, 20);
      writeU16(header, 6, 20);
      writeU16(header, 8, 0x0800);
      writeU16(header, 10, 0);
      writeU16(header, 12, stamp.time);
      writeU16(header, 14, stamp.date);
      writeU32(header, 16, entry.crc);
      writeU32(header, 20, entry.data.length);
      writeU32(header, 24, entry.data.length);
      writeU16(header, 28, entry.nameBytes.length);
      writeU16(header, 30, 0);
      writeU16(header, 32, 0);
      writeU16(header, 34, 0);
      writeU16(header, 36, 0);
      writeU32(header, 38, 0);
      writeU32(header, 42, file.offset);
      header.set(entry.nameBytes, 46);
      return header;
    }

    function buildEndRecord(fileCount, centralSize, centralOffset) {
      var end = new Uint8Array(22);
      writeU32(end, 0, 0x06054b50);
      writeU16(end, 4, 0);
      writeU16(end, 6, 0);
      writeU16(end, 8, fileCount);
      writeU16(end, 10, fileCount);
      writeU32(end, 12, centralSize);
      writeU32(end, 16, centralOffset);
      writeU16(end, 20, 0);
      return end;
    }

    function appendBytes(target, offset, source) {
      target.set(source, offset);
      return offset + source.length;
    }

    function writeU16(buffer, offset, value) {
      buffer[offset] = value & 0xff;
      buffer[offset + 1] = (value >>> 8) & 0xff;
    }

    function writeU32(buffer, offset, value) {
      buffer[offset] = value & 0xff;
      buffer[offset + 1] = (value >>> 8) & 0xff;
      buffer[offset + 2] = (value >>> 16) & 0xff;
      buffer[offset + 3] = (value >>> 24) & 0xff;
    }

    function dosDateTime(date) {
      var year = Math.max(1980, date.getFullYear());
      return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
      };
    }

    function crc32(bytes) {
      if (!crcTable) crcTable = makeCrcTable();

      var crc = 0xffffffff;
      for (var i = 0; i < bytes.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
      }

      return (crc ^ 0xffffffff) >>> 0;
    }

    function makeCrcTable() {
      var table = [];

      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var k = 0; k < 8; k++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
      }

      return table;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    onRequest: onRequest
  };
});
