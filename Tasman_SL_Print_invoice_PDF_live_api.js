/**
* @NApiVersion 2.x
* @NScriptType Suitelet
* @NModuleScope SameAccount
*
* Reformatted from the original single-invoice "Print BC PDF" Suitelet.
* Same script/deployment supports two modes via URL parameters:
*
*   ?recId=<invoiceId>   -> renders + streams one invoice PDF, saves it to the file
*                           cabinet, stamps custbody_bc_pdf_file.
*
*   ?custId=<customerId> -> Finds all invoices flagged "To Be Printed" for that customer,
*                           renders EACH ONE AS ITS OWN PDF named
*                           "<tranid> <1st word of job.custentity26>_<initials from job.custentity4>.pdf",
*                           then streams all of them back as a single ZIP download.
*                           Each invoice is also saved to the file cabinet and stamped with its
*                           own custbody_bc_pdf_file, and has its "To Be Printed" checkbox
*                           cleared, so clicking the button again only picks up invoices newly
*                           flagged since the last run.
*
* CHANGE LOG (v17):
*   - FIX: file.create() for each generated PDF was passing encoding: file.Encoding.UTF8 on
*     binary PDF content. Any byte >127 in the stream (AcroForm field dictionaries, appearance
*     streams, embedded fonts) gets reinterpreted/mangled as UTF-8 text during that round-trip,
*     which silently breaks the PDF's fillable form fields even though the PDF still opens and
*     renders visually. Single-invoice mode never hit this because it streams the raw
*     render.renderAsPdf() output directly instead of going through file.create(). Removed the
*     encoding param so file.create() writes the binary content untouched. This affected the
*     saved-to-cabinet PDF, the custbody_bc_pdf_file-stamped copy, AND the ZIP entry in bulk
*     mode (since pdfFile is what gets zipped when ZIP_FROM_SAVED_FILES is false), so this is
*     the fix for "form fields used to be editable in Adobe, now they aren't" on bulk exports.
*
* CHANGE LOG (v16):
*   - File name boundaries are now per-field, not one global separator: a SPACE after the
*     tranid, an UNDERSCORE between custentity26 and custentity4 ->
*     "INV1042 Riverbend_JD.pdf". Set via each JOB_NAME_FIELDS entry's `separator`.
*   - JOB_NAME_FIELDS, JOB_NAME_FIELD_TRANSFORMS and FILE_NAME_SEPARATOR collapsed into a
*     single declarative spec array; the two wiring lines at the bottom are gone.
*
* CHANGE LOG (v15):
*   - Whitespace inside a value is normalised to an underscore per-part; the ZIP name is
*     fully underscore-separated (ZIP_NAME_SEPARATOR).
*
* CHANGE LOG (v14):
*   - custentity26 contributes only its FIRST WORD to the file name.
*   - custentity4 contributes APPROVER INITIALS parsed from its "ENV-<name>" value.
*   - Both via per-field `transform` functions, so further per-field rules don't need
*     changes to buildInvoiceFileName().
*   - getJobNameParts() now returns one entry PER FIELD; the old flat array desynced from
*     JOB_NAME_FIELDS if either field was a multiselect.
*
* CHANGE LOG (v13):
*   - File name parts are now space-separated, not " - " separated.
*   - Job name field changed from custentity25 to custentity26 (JOB_NAME_FIELDS).
*
* CHANGE LOG (v12):
*   - Bulk mode delivers a ZIP of individually-named PDFs (N/compress) instead of the v11
*     HTML index page. One click, one download. renderResultsPage()/escapeHtml()/getFileUrl()
*     removed as dead weight; per-run reporting moved into _manifest.txt inside the ZIP.
*
* CHANGE LOG (v11):
*   - Bulk mode no longer merges into one <pdfset> PDF; each invoice is a separate PDF.
*   - New file naming convention applied in BOTH modes via buildInvoiceFileName().
*     To keep single-invoice mode on the old "<tranid>.pdf" name, see the ONE-LINE REVERT
*     note inside buildInvoicePdf().
*   - Bulk mode now stamps custbody_bc_pdf_file per invoice (it couldn't before, because
*     there was no per-invoice file). Toggle with STAMP_PDF_FIELD_IN_BULK.
*   - Added a per-execution cache to determineBillGrouping(); it was running one search per
*     billable line with no reuse, which was the single largest governance consumer in bulk mode.
*   - Removed stripXmlPreamble() and the asXmlString branch of buildInvoicePdf(); both existed
*     only to support <pdfset> merging.
*
* NOTE on which invoices are picked up: getOpenInvoiceIdsForCustomer() filters solely on
* tobeprinted = T (the native "To Be Printed" flag), matching how native bulk print
* selects documents. Transaction status is not considered.
*
* CHANGE LOG (v18):
*   - PERFORMANCE: bulk mode now defaults to ZIP-only delivery. It no longer saves and
*     stamps every invoice PDF during the customer bulk run, which removes about 30
*     governance units per invoice. Single-invoice mode is unchanged.
*   - PERFORMANCE: employee billing-class and time billing-class lookups are narrowed to
*     the employee/time ids actually present on the invoice instead of doing account- or
*     project-wide searches.
*   - PERFORMANCE: vendor bill / expense report grouping now uses lookupFields and avoids
*     extra runPaged().count logging searches.
*
* CHANGE LOG (v19):
*   - Added ?mode=bulkPdf&recId=<invoiceId> for the browser-orchestrated bulk UI. This
*     renders one named PDF per request without saving/stamping the invoice, allowing the
*     browser to assemble a ZIP across many fresh Suitelet requests.
*/

define(['N/render', 'N/record', 'N/xml', 'N/file', 'N/task', 'N/search', 'N/runtime', 'N/url', 'N/config', 'N/format', 'N/compress'], function(render, record, xml, file, task, search, runtime, url, config, format, compress) {

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------
  var TEMPLATE_FILE_ID = 7618;   // BFO/FreeMarker template in the file cabinet
  var PDF_FOLDER_ID    = 2654;   // destination folder for generated invoice PDFs
  var LOGO_SUBSIDIARY_ID = 1;

  // Job (project) fields appended to the tranid, in order, to form the file name.
  //
  //   <tranid> + ' ' + firstWord(custentity26) + '_' + approverInitials(custentity4)
  //   e.g. "INV1042 Riverbend_JD.pdf"
  //
  // `separator` is what PRECEDES that field, so each boundary is set independently - a
  // space after the tranid, an underscore between the two job fields. `transform` is
  // optional; omit it to use the field's value verbatim. firstWord/approverInitials are
  // function declarations further down and so are hoisted, hence usable here.
  var JOB_NAME_FIELDS = [
    { fieldId: 'custentity26', separator: ' ', transform: firstWord },
    { fieldId: 'custentity4',  separator: '_', transform: approverInitials }
  ];

  // Pattern that strips the "ENV-" prefix off custentity4 and captures the rest.
  // Tolerates "ENV-", "env -", "ENV_", "ENV:" and any spacing. Change 'env' here if the
  // prefix is ever renamed. The capture is deliberately (.*) not (.+): a bare "ENV-" with
  // nothing after it must still count as "prefix found, no name", so it returns blank
  // rather than failing to match and falling through to the whole-value fallback.
  var APPROVER_PREFIX_PATTERN = /env\s*[-\u2013\u2014_:]\s*(.*)$/i;

  // A single all-letter token no longer than this is treated as initials that are already
  // initials ("JD" stays "JD") rather than a surname to be reduced to one letter.
  var MAX_EXISTING_INITIALS_LENGTH = 4;

  // Separator used in the ZIP file name, independent of the PDF name boundaries above.
  var ZIP_NAME_SEPARATOR = '_';
  var MAX_FILE_NAME_LENGTH = 200;   // NetSuite hard limit is 255; leave headroom for ".pdf"

  // Bulk mode: stamp custbody_bc_pdf_file on each invoice with its own PDF.
  // Costs ~10 governance units per invoice. Leave false for fastest customer bulk printing.
  var STAMP_PDF_FIELD_IN_BULK = false;

  // Bulk mode: also persist each PDF to PDF_FOLDER_ID (20 units each) rather than only
  // putting it in the ZIP. Required for STAMP_PDF_FIELD_IN_BULK to have a file id to
  // stamp; leave false if the client only needs the ZIP/download from the button.
  var SAVE_INDIVIDUAL_PDFS_TO_CABINET = false;

  // Bulk mode: keep a copy of the generated ZIP in the file cabinet as well as streaming it.
  var SAVE_ZIP_TO_CABINET = false;

  // Include a _manifest.txt inside the ZIP summarising what was generated, what failed,
  // and what was left for the next run. Costs nothing and saves a trip to the script log.
  var INCLUDE_ZIP_MANIFEST = true;

  // If archiver.add() rejects in-memory files in this account's version, flip this to true
  // to re-load each saved PDF from the file cabinet before adding it. Costs 10 units per
  // invoice and more memory, so it's off by default. Requires SAVE_INDIVIDUAL_PDFS_TO_CABINET.
  var ZIP_FROM_SAVED_FILES = false;

  // ---------------------------------------------------------------------
  // Per-execution caches. In single-invoice mode these are populated once and
  // behave exactly as before. In bulk mode they stop us from re-running the same
  // account-wide lookups for every invoice, which is where most of the governance
  // was going (getBillingClass alone is a full employee search per invoice).
  // ---------------------------------------------------------------------
  var _billingClassCache = {};
  var _billingClassFullCacheLoaded = false;
  var _timeBillingCache = {};
  var _timeBillingFullCacheLoaded = {};
  var _templateCache = null;
  var _jobNamePartsCache = {};
  var _billGroupingCache = {};

  var SCRIPT_VERSION = 'v19-2026-08-28-live-browser-api';

  function onRequest(context) {

    log.audit('Script version', SCRIPT_VERSION);

    var response = context.response;

    if (context.request.method !== 'GET') return;

    var mode = context.request.parameters.mode;
    var recId = context.request.parameters.recId;
    var custId = context.request.parameters.custId;

    try {
      if (recId) {
        // ---- single-invoice behavior: stream the PDF inline ----
        // mode=bulkPdf is used by the browser bulk UI. It intentionally avoids
        // per-invoice cabinet saves and custbody_bc_pdf_file stamps, so each request
        // only pays the render/data-gathering cost.
        var isBrowserBulkPdf = mode === 'bulkPdf';
        var result = buildInvoicePdf(recId, !isBrowserBulkPdf, !isBrowserBulkPdf);
        response.writeFile({
          file: isBrowserBulkPdf ? result.pdfFile : result.file,
          isInline: true
        });
        return;
      }

      if (custId) {
        // ---- bulk: one PDF per open invoice, then return an index page ----
        printAllOpenInvoicesForCustomer(context, custId);
        return;
      }

      response.write('Missing recId or custId parameter.');

    } catch (e) {
      log.error('onRequest error', e);
      response.write('Error generating PDF: ' + e.message);
    }
  }

  /**
   * Builds the PDF for a single invoice using the same data-gathering and
   * template-rendering logic as the original script.
   * @param {string|number} recId - internal id of the invoice
   * @param {boolean} stampInvoice - if true, stamps custbody_bc_pdf_file on the invoice
   *        with the generated PDF's file id. Requires saveToCabinet.
   * @param {boolean} [saveToCabinet=true] - if false, the PDF is returned in memory only and
   *        never written to PDF_FOLDER_ID. Defaults to true so single-invoice mode is unchanged.
   * @returns {{trandoc: string, fileName: string, file: File, pdfFile: File, fileId: number}}
   *        `file` is the raw render output (used for streaming a single invoice); `pdfFile` is
   *        the same content under the client's naming convention (used as a ZIP entry).
   */
  function buildInvoicePdf(recId, stampInvoice, saveToCabinet) {

    if (saveToCabinet === undefined) saveToCabinet = true;

    log.debug('recId', recId);
    var finalArray = [];

    var newRecord = record.load({type: 'invoice', id: recId});
    var trandoc = newRecord.getText({fieldId: 'tranid'});
    var job = newRecord.getValue({fieldId: 'job'});
    var customer = newRecord.getValue({fieldId: 'entity'});
    var useChevronSort = isCustomerChevronSortEnabled(customer, job);
    log.debug('useChevronSort', useChevronSort);

    var invoiceEmployeeIds = collectInvoiceEmployeeIds(newRecord);
    var empbillingClass = getBillingClass(invoiceEmployeeIds);
    log.debug('empbillingClass', empbillingClass);

    // Capture Billable Items from the 'item' sublist
    var itemCount = newRecord.getLineCount({ sublistId: 'item' });
    for (var i = 0; i < itemCount; i++) {

      var item = newRecord.getSublistText({
        sublistId: 'item',
        fieldId: 'item',
        line: i,
      });
      var description = newRecord.getSublistText({
        sublistId: 'item',
        fieldId: 'description',
        line: i,
      });
      var date = newRecord.getSublistText({
        sublistId: 'item',
        fieldId: 'custcol2',
        line: i,
      });
      var quantity = newRecord.getSublistText({
        sublistId: 'item',
        fieldId: 'quantity',
        line: i,
      });
      var itemRate = newRecord.getSublistValue({
        sublistId: 'item',
        fieldId: 'rate',
        line: i,
      });
      var custcol_bc_employee = newRecord.getSublistValue({
        sublistId: 'item',
        fieldId: 'custcol_bc_employee',
        line: i,
      });
      var custcol_bc_employee_text = newRecord.getSublistText({
        sublistId: 'item',
        fieldId: 'custcol_bc_employee',
        line: i,
      });
      var itemAmount = newRecord.getSublistValue({
        sublistId: 'item',
        fieldId: 'amount',
        line: i,
      });
      var grouping = '';
      if (custcol_bc_employee) {
        if (empbillingClass[custcol_bc_employee]) {
          var billingclass = empbillingClass[custcol_bc_employee][0].class;
          var isMaterialGrouping = empbillingClass[custcol_bc_employee][0].custentity10;
          var isEquipmentGrouping = empbillingClass[custcol_bc_employee][0].custentity9;
          if (isMaterialGrouping) grouping = 'Material';
          else if (isEquipmentGrouping) grouping = 'Equipment';
          else grouping = 'Labor';

          item = billingclass;
        } else {
          grouping = "Other";
          item = billingclass;
        }
      } else {
        grouping = "Other";
      }

      var itemData = {
        type: 'Item',
        name: item,
        tranid: '',
        memoID: description,
        amount: itemAmount,
        billedDate: date,
        qty: quantity,
        rate: itemRate,
        grouping: grouping,
        sortEmployee: custcol_bc_employee_text || getEmployeeName(empbillingClass, custcol_bc_employee),
        sortIndex: finalArray.length,
      };

      finalArray.push(itemData);
    }

    var itemLineCount = newRecord.getLineCount({ sublistId: 'itemcost' });
    var costDisc = newRecord.getValue('itemcostdiscrate') || 0;
    var costDiscName = newRecord.getText('itemcostdiscount') || '';
    for (var i = 0; i < itemLineCount; i++) {
      var apply = newRecord.getSublistValue({
        sublistId: 'itemcost',
        fieldId: 'apply',
        line: i,
      });

      if (apply) {
        var transactionID = newRecord.getSublistValue({
          sublistId: 'itemcost',
          fieldId: 'doc',
          line: i,
        });
        var itemMemoID = newRecord.getSublistValue({
          sublistId: 'itemcost',
          fieldId: 'memo',
          line: i,
        });
        var item = newRecord.getSublistText({
          sublistId: 'itemcost',
          fieldId: 'itemdisp',
          line: i,
        });
        var itemAmount = newRecord.getSublistValue({
          sublistId: 'itemcost',
          fieldId: 'amount',
          line: i,
        });
        var billedDate = newRecord.getSublistText({
          sublistId: 'itemcost',
          fieldId: 'billeddate',
          line: i,
        });

        var rate = newRecord.getSublistValue({
          sublistId: 'itemcost',
          fieldId: 'cost',
          line: i,
        });

        var qty = newRecord.getSublistValue({
          sublistId: 'itemcost',
          fieldId: 'itemcostcount',
          line: i,
        });
        var grouping = determineBillGrouping(transactionID, 'vendorbill');
        var tranid = grouping.tranid;
        var group = grouping.type;
        var entity = grouping.entity;

        var itemData = {
          type: 'Item',
          name: item,
          disc: costDisc,
          disName: costDiscName,
          discAmt: parseFloat(itemAmount) * parseFloat(costDisc) / 100,
          entity: entity,
          tranid: tranid,
          memoID: itemMemoID,
          amount: itemAmount,
          billedDate: billedDate,
          qty: qty,
          rate: rate,
          grouping: group,
          sortEmployee: entity,
          sortIndex: finalArray.length,
        };

        finalArray.push(itemData);
      }
    }

    // Capture Billable Expenses from the 'expcost' sublist
    var expenseLineCount = newRecord.getLineCount({ sublistId: 'expcost' });
    var expDisc = newRecord.getValue('expcostdiscrate') || 0;
    var expDiscName = newRecord.getText('expcostdiscount') || '';
    for (var j = 0; j < expenseLineCount; j++) {
      var apply = newRecord.getSublistValue({
        sublistId: 'expcost',
        fieldId: 'apply',
        line: j,
      });

      if (apply) {
        var transactionID = newRecord.getSublistValue({
          sublistId: 'expcost',
          fieldId: 'doc',
          line: j,
        });
        var expenseMemoID = newRecord.getSublistValue({
          sublistId: 'expcost',
          fieldId: 'memo',
          line: j,
        });
        var expenseAmount = newRecord.getSublistValue({
          sublistId: 'expcost',
          fieldId: 'amount',
          line: j,
        });

        var billeddate = newRecord.getSublistText({
          sublistId: 'expcost',
          fieldId: 'billeddate',
          line: j,
        });
        var employeedisp = newRecord.getSublistValue({
          sublistId: 'expcost',
          fieldId: 'employee',
          line: j,
        });
        var employeeText = newRecord.getSublistText({
          sublistId: 'expcost',
          fieldId: 'employee',
          line: j,
        });
        var urlcode = newRecord.getSublistValue({
          sublistId: 'expcost',
          fieldId: 'url',
          line: j,
        });
        if (employeedisp) {
          var grouping = determineBillGrouping(transactionID, 'expensereport');
          var group = 'Other';
          var entity = grouping.entity;
          var tranid = grouping.tranid;
        } else {
          var grouping = determineBillGrouping(transactionID, 'vendorbill');
          var tranid = grouping.tranid;
          var group = grouping.type;
          var entity = grouping.entity;
        }

        var expenseData = {
          type: 'Expense',
          name: entity,
          disc: expDisc,
          disName: expDiscName,
          discAmt: parseFloat(expenseAmount) * parseFloat(expDisc) / 100,
          entity: entity,
          tranid: tranid,
          qty: 1,
          memoID: expenseMemoID,
          rate: expenseAmount,
          amount: expenseAmount,
          billedDate: billeddate,
          grouping: group,
          sortEmployee: employeeText || entity,
          sortIndex: finalArray.length
        };
        if (urlcode && urlcode.indexOf("/cardchrg.nl") != -1) {
          expenseData.name = expenseMemoID;
          expenseData.memoID = '';
        }
        log.audit('expenseData', expenseData);

        finalArray.push(expenseData);
      }
    }

    var invoiceTimeIds = collectInvoiceTimeIds(newRecord);
    var empbillingTime = getTimeBillingClass(job, invoiceTimeIds);
    // Capture Billable Time from the 'time' sublist
    var timeLineCount = newRecord.getLineCount({ sublistId: 'time' });
    for (var k = 0; k < timeLineCount; k++) {
      var apply = newRecord.getSublistValue({
        sublistId: 'time',
        fieldId: 'apply',
        line: k,
      });

      if (apply) {
        var timeID = newRecord.getSublistValue({
          sublistId: 'time',
          fieldId: 'doc',
          line: k,
        });
        var timeMemoID = newRecord.getSublistValue({
          sublistId: 'time',
          fieldId: 'memo',
          line: k,
        });
        var timeAmount = newRecord.getSublistValue({
          sublistId: 'time',
          fieldId: 'amount',
          line: k,
        });
        var timeQty = newRecord.getSublistText({
          sublistId: 'time',
          fieldId: 'quantity',
          line: k,
        });
        log.audit('timeQty', timeQty);

        if (timeQty.indexOf(":") != -1) {
          var parts = timeQty.split(":");
          var min = parseFloat(parts[1]) / 60;
          log.audit('min', min);
          if (min == 0) min = 00;
          log.audit('min', min);

          timeQty = parseFloat(parts[0]) + parseFloat(min);
          log.audit('timeQty', timeQty);
        }
        var timeRate = newRecord.getSublistValue({
          sublistId: 'time',
          fieldId: 'rate',
          line: k,
        });
        var emp = newRecord.getSublistText({
          sublistId: 'time',
          fieldId: 'employeedisp',
          line: k,
        });
        var empid = newRecord.getSublistValue({
          sublistId: 'time',
          fieldId: 'employee',
          line: k,
        });
        log.debug("empid", empid);

        var billingclass = '';
        var group = '';

        if (timeID && empbillingTime[timeID]) {
          billingclass = empbillingTime[timeID][0].class;
        }

        if (empid && empbillingClass[empid]) {

          if (!billingclass) billingclass = empbillingClass[empid][0].class;
          var isMaterialGrouping = empbillingClass[empid][0].custentity10;
          var isEquipmentGrouping = empbillingClass[empid][0].custentity9;
          if (isMaterialGrouping) group = 'Material';
          else if (isEquipmentGrouping) group = 'Equipment';
          else group = 'Labor';
        }
        var billedDate = newRecord.getSublistText({
          sublistId: 'time',
          fieldId: 'billeddate',
          line: k,
        });

        if (grouping == "Labor") {
          tranid = '';
        }

        var timeData = {
          type: 'Time',
          name: billingclass,
          tranid: '',
          memoID: timeMemoID,
          amount: timeAmount,
          qty: timeQty,
          rate: timeRate,
          billedDate: billedDate,
          grouping: group,
          sortEmployee: emp || getTimeEmployeeName(empbillingTime, timeID) || getEmployeeName(empbillingClass, empid),
          sortIndex: finalArray.length
        };

        finalArray.push(timeData);
      }
    }

    finalArray = groupAndSummarize(finalArray, useChevronSort);
    log.debug('Final Array', finalArray);

    // Template contents + logo are identical for every invoice, so build once per
    // execution and reuse. Inlined deliberately rather than calling out to a helper.
    if (_templateCache === null) {
      var loadedTemplate = file.load({
        id: TEMPLATE_FILE_ID
      }).getContents();

      var subrec = record.load({type: 'subsidiary', id: LOGO_SUBSIDIARY_ID});
      var logo = subrec.getValue('logo');

      if (logo) {
        var fileUrl = file.load({id: logo}).url;
        fileUrl = fileUrl.replace(/&/g, "&amp;");
        log.debug('fileUrl', fileUrl);
        loadedTemplate = loadedTemplate.replace('${logoURL}', fileUrl);
      }

      _templateCache = loadedTemplate;
    }

    var xmlTemplateFile = _templateCache;

    var renderer = render.create();

    renderer.addRecord({
      templateName: 'record',
      record: newRecord
    });

    var hasREM = false;
    for (var m = 0; m < finalArray.length; m++) {
      if (finalArray[m].tranid && finalArray[m].tranid !== '') {
        hasREM = true;
        break;
      }
    }

    renderer.addCustomDataSource({
      format: render.DataSource.OBJECT,
      alias: 'results',
      data: {
        results: finalArray,
        hasREM: hasREM
      }
    });

    renderer.templateContent = xmlTemplateFile;

    var coverfile = renderer.renderAsPdf();

    // ONE-LINE REVERT: to keep single-invoice mode on the old "<tranid>.pdf" name,
    // change the line below to:  var fileName = trandoc + '.pdf';
    var fileName = buildInvoiceFileName(trandoc, job);

    // v17 FIX: no `encoding` param here. This content is binary PDF data coming straight
    // out of renderAsPdf().getContents() - it can (and for fillable forms, does) contain
    // AcroForm dictionaries, appearance streams, and embedded font bytes above 127. Forcing
    // file.Encoding.UTF8 reinterprets those bytes as UTF-8 text and mangles them, which
    // silently strips/breaks the PDF's fillable form fields while the page still renders
    // fine visually. Single-invoice mode was never affected because it streams
    // renderer output directly and never passes it through file.create(). Leaving encoding
    // unset lets file.create() write the bytes through untouched.
    var pdfFile = file.create({
      name: fileName,
      fileType: file.Type.PDF,
      contents: coverfile.getContents(),
      folder: PDF_FOLDER_ID
    });

    var fileId = null;
    if (saveToCabinet) {
      fileId = saveOverwritingDuplicate(pdfFile, fileName);
      log.audit('PDF Saved', fileName + ' (File ID: ' + fileId + ')');
    }

    if (stampInvoice && fileId) {
      try {
        // submitFields does an inline field update and skips full-record validation.
        // A full record.save() here re-runs posting period validation and throws
        // INVALID_KEY_OR_REF on invoices whose period is closed/invalid for their
        // subsidiary - which is unnecessary just to stamp one body field.
        record.submitFields({
          type: record.Type.INVOICE,
          id: recId,
          values: {
            custbody_bc_pdf_file: fileId
          },
          options: {
            enableSourcing: false,
            ignoreMandatoryFields: true
          }
        });
      } catch (error) {
        log.error('Failed to stamp custbody_bc_pdf_file on invoice ' + recId, error);
      }
    }

    return {
      trandoc: trandoc,
      fileName: fileName,
      file: coverfile,
      pdfFile: pdfFile,
      fileId: fileId
    };
  }

  function collectInvoiceEmployeeIds(invoiceRecord) {
    var ids = [];
    var i;

    var itemCount = invoiceRecord.getLineCount({ sublistId: 'item' });
    for (i = 0; i < itemCount; i++) {
      addUniqueId(ids, invoiceRecord.getSublistValue({
        sublistId: 'item',
        fieldId: 'custcol_bc_employee',
        line: i
      }));
    }

    var timeLineCount = invoiceRecord.getLineCount({ sublistId: 'time' });
    for (i = 0; i < timeLineCount; i++) {
      var apply = invoiceRecord.getSublistValue({
        sublistId: 'time',
        fieldId: 'apply',
        line: i
      });

      if (!apply) continue;

      addUniqueId(ids, invoiceRecord.getSublistValue({
        sublistId: 'time',
        fieldId: 'employee',
        line: i
      }));
    }

    return ids;
  }

  function collectInvoiceTimeIds(invoiceRecord) {
    var ids = [];
    var timeLineCount = invoiceRecord.getLineCount({ sublistId: 'time' });

    for (var i = 0; i < timeLineCount; i++) {
      var apply = invoiceRecord.getSublistValue({
        sublistId: 'time',
        fieldId: 'apply',
        line: i
      });

      if (!apply) continue;

      addUniqueId(ids, invoiceRecord.getSublistValue({
        sublistId: 'time',
        fieldId: 'doc',
        line: i
      }));
    }

    return ids;
  }

  function addUniqueId(ids, id) {
    if (id === null || id === undefined || id === '') return;

    var textId = String(id);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === textId) return;
    }

    ids.push(textId);
  }

  function normalizeIdList(ids) {
    var normalized = [];

    if (!ids) return normalized;
    if (Object.prototype.toString.call(ids) !== '[object Array]') ids = [ids];

    for (var i = 0; i < ids.length; i++) {
      addUniqueId(normalized, ids[i]);
    }

    return normalized;
  }

  // ---------------------------------------------------------------------
  // File naming
  // ---------------------------------------------------------------------

  /**
   * Builds "<tranid> <first word of custentity26>_<initials from custentity4>.pdf".
   *
   * Each boundary comes from its JOB_NAME_FIELDS entry's `separator`, so the space after the
   * tranid and the underscore between the two job fields are set independently rather than
   * sharing one global separator.
   *
   * A part that ends up blank (no job on the invoice, empty field, or a transform that finds
   * nothing usable) is skipped AND takes its separator with it - so a missing custentity26
   * gives "INV1042_JD.pdf", not "INV1042 _JD.pdf". Illegal file-name characters are stripped
   * and the result is capped below NetSuite's 255-char limit.
   */
  function buildInvoiceFileName(trandoc, jobId) {
    var name = sanitizeFileNamePart(trandoc);

    var jobParts = getJobNameParts(jobId);
    for (var i = 0; i < jobParts.length; i++) {
      var spec = jobParts[i].spec;
      var raw = jobParts[i].value;
      var transformed = spec.transform ? spec.transform(raw) : raw;

      var clean = sanitizeFileNamePart(transformed);
      if (!clean) continue;

      name = name ? name + spec.separator + clean : clean;
    }

    // Nothing usable at all (shouldn't happen - tranid is always populated) - fall
    // back to a literal so file.create() never gets an empty name.
    name = tidyFileName(name) || 'Invoice';

    if (name.length > MAX_FILE_NAME_LENGTH) {
      name = name.substring(0, MAX_FILE_NAME_LENGTH).replace(/[_\s\-]+$/, '');
    }

    return name + '.pdf';
  }

  /**
   * Returns one {spec, value} entry per JOB_NAME_FIELDS entry, in order, as display text.
   * Cached per execution because in bulk mode several invoices commonly share a job.
   *
   * Carrying the spec through (rather than just the value) keeps each value welded to its own
   * separator and transform. search.lookupFields returns a plain string for free-form fields
   * but an array of {value,text} for selects/multiselects, so a flat array of values would let
   * a multiselect contribute several slots and desync from JOB_NAME_FIELDS - silently applying
   * custentity4's rules to custentity26's value. Multi-values are joined into one entry instead.
   */
  function getJobNameParts(jobId) {
    if (!jobId) return [];

    var cacheKey = String(jobId);
    if (_jobNamePartsCache[cacheKey]) return _jobNamePartsCache[cacheKey];

    var parts = [];

    try {
      var fieldIds = [];
      for (var f = 0; f < JOB_NAME_FIELDS.length; f++) {
        fieldIds.push(JOB_NAME_FIELDS[f].fieldId);
      }

      var jobFields = search.lookupFields({
        type: 'job',
        id: jobId,
        columns: fieldIds
      });

      for (var i = 0; i < JOB_NAME_FIELDS.length; i++) {
        var spec = JOB_NAME_FIELDS[i];
        var flattened = [];

        addLookupText(flattened, jobFields[spec.fieldId]);

        parts.push({
          spec: spec,
          value: flattened.join(' ')
        });
      }
    } catch (e) {
      log.error('Job name field lookup failed for job ' + jobId, e);
    }

    _jobNamePartsCache[cacheKey] = parts;
    return parts;
  }

  // ---------------------------------------------------------------------
  // Job field transforms
  // ---------------------------------------------------------------------

  /**
   * First whitespace-delimited token.
   *   "Riverbend Tower Phase 2" -> "Riverbend"
   */
  function firstWord(value) {
    var text = normalizeSortText(value);   // trims; case is restored from the original below
    if (!text) return '';

    var original = String(value).replace(/^\s+|\s+$/g, '');
    var tokens = original.split(/\s+/);

    return tokens[0] || '';
  }

  /**
   * Pulls approver initials out of an "ENV-<name>" value.
   *
   *   "ENV-John Doe"    -> "JD"     (multi-word name: initial of each word)
   *   "ENV-John Q. Doe" -> "JQD"    (punctuation isn't a word)
   *   "ENV-JD"          -> "JD"     (already initials: passed through, uppercased)
   *   "ENV-Doe"         -> "D"      (single capitalised name: reduced to its initial)
   *   "ENV-"            -> ""       (prefix but no name: component skipped)
   *   "John Doe"        -> "JD"     (no ENV- prefix: whole value used, logged at debug)
   *
   * The no-prefix fallback is deliberate - a slightly-off initial beats dropping the
   * component from the file name entirely, and it shows up in the log if the data is wrong.
   */
  function approverInitials(value) {
    var text = String(value === null || value === undefined ? '' : value)
      .replace(/^\s+|\s+$/g, '');

    if (!text) return '';

    var match = APPROVER_PREFIX_PATTERN.exec(text);
    var remainder;

    if (match) {
      remainder = match[1];
    } else {
      log.debug('Approver field has no ENV- prefix', 'Using whole value: ' + text);
      remainder = text;
    }

    // Split on anything non-alphabetic so periods, hyphens and commas in a name
    // ("John Q. Doe", "Smith-Jones") don't produce empty tokens.
    var words = [];
    var rawWords = remainder.split(/[^A-Za-z]+/);
    for (var i = 0; i < rawWords.length; i++) {
      if (rawWords[i]) words.push(rawWords[i]);
    }

    if (!words.length) return '';

    // One token: is it already initials ("JD"), or a surname to reduce ("Doe")?
    // Length alone can't tell them apart, so lean on capitalisation - an initial-capital
    // followed by lowercase is a name, not initials. "JD"/"jd" -> kept, "Doe" -> "D",
    // "SMITH" -> "S" (all caps but too long to be initials).
    if (words.length === 1) {
      var looksLikeInitials = words[0].length <= MAX_EXISTING_INITIALS_LENGTH &&
        !/[A-Z][a-z]/.test(words[0]);

      if (looksLikeInitials) return words[0].toUpperCase();

      return words[0].charAt(0).toUpperCase();
    }

    var initials = '';
    for (var j = 0; j < words.length; j++) {
      initials += words[j].charAt(0).toUpperCase();
    }

    return initials;
  }

  /**
   * Final tidy-up for an assembled file name: no doubled-up underscores, and nothing left
   * dangling at either end.
   *
   * Deliberately does NOT touch interior whitespace - the single space between the tranid and
   * custentity26 is intentional. Whitespace coming from the DATA is normalised per-part by
   * sanitizeFileNamePart() before assembly, so anything reaching here is a separator we chose.
   */
  function tidyFileName(name) {
    return String(name === null || name === undefined ? '' : name)
      .replace(/_{2,}/g, '_')
      .replace(/^[_\s]+|[_\s]+$/g, '');
  }

  /**
   * Normalises ONE component of a file name: strips characters NetSuite rejects (path
   * separators, wildcards, quotes, control chars) and collapses any internal whitespace to a
   * single underscore.
   *
   * Whitespace inside a part becomes an underscore rather than a space so it can't be confused
   * with the one intentional space in the assembled name. In practice firstWord() and
   * approverInitials() already return single tokens, so this only bites on a tranid or customer
   * name that itself contains a space ("INV 1042" -> "INV_1042").
   */
  function sanitizeFileNamePart(value) {
    if (value === null || value === undefined) return '';

    return String(value)
      .replace(/[\/\\:\*\?"<>\|\r\n\t]/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\s+/g, '_');
  }

  /**
   * Saves a file, handling the case where a file of the same name already exists in the
   * target folder (NetSuite rejects the duplicate). Only pays for the lookup/delete when
   * the save actually fails, so the common path costs nothing extra. The newest PDF wins
   * - if the client would rather keep history, append a timestamp in buildInvoiceFileName()
   * instead of deleting here.
   */
  function saveOverwritingDuplicate(pdfFile, fileName) {
    try {
      return pdfFile.save();
    } catch (e) {
      log.audit('Initial file save failed, checking for duplicate name', fileName + ': ' + e.message);

      var existingId = findExistingFileId(fileName, PDF_FOLDER_ID);
      if (!existingId) throw e;

      file.delete({ id: existingId });
      log.audit('Replaced existing file', fileName + ' (old File ID: ' + existingId + ')');
      return pdfFile.save();
    }
  }

  function findExistingFileId(fileName, folderId) {
    var foundId = null;

    try {
      var fileSearch = search.create({
        type: 'file',
        filters: [
          ['name', 'is', fileName],
          'AND', ['folder', 'anyof', folderId]
        ],
        columns: ['internalid']
      });

      fileSearch.run().each(function (result) {
        foundId = result.getValue({ name: 'internalid' });
        return false;
      });
    } catch (e) {
      log.error('Duplicate file lookup failed for ' + fileName, e);
    }

    return foundId;
  }

  // ---------------------------------------------------------------------
  // Bulk mode
  // ---------------------------------------------------------------------

  /**
   * Renders every invoice flagged "To Be Printed" for a customer as its OWN PDF, named per
   * buildInvoiceFileName(), then streams all of them back as a single ZIP.
   *
   * Order of operations matters: the ZIP is built BEFORE any "To Be Printed" flag is cleared.
   * If archiving throws, we bail out with every flag still set, so the user can just click the
   * button again rather than discovering the invoices were silently de-flagged with no download.
   */
  function printAllOpenInvoicesForCustomer(context, custId) {
    var response = context.response;

    var invoiceIds = getOpenInvoiceIdsForCustomer(custId);

    if (!invoiceIds.length) {
      response.write('No invoices for this customer are flagged "To Be Printed".');
      return;
    }

    log.audit('Bulk print starting', invoiceIds.length + ' invoices flagged To Be Printed for customer ' + custId);

    var script = runtime.getCurrentScript();
    var generated = [];
    var failed = [];
    var renderedIds = [];
    var pdfFiles = [];
    var skipped = 0;

    for (var i = 0; i < invoiceIds.length; i++) {
      // A Suitelet has 1000 units. Stop cleanly and ZIP what we have rather than dying
      // mid-loop and handing back nothing. The reserve grows with the number of invoices
      // already rendered because each delivered invoice still needs its To Be Printed flag
      // cleared after the ZIP is built.
      var usageFloor = getBulkStopUsageFloor(renderedIds.length + 1);
      if (script.getRemainingUsage() < usageFloor) {
        skipped = invoiceIds.length - i;
        log.audit('Governance limit reached', 'Generated ' + generated.length + ' of ' + invoiceIds.length + ' invoices; ' + skipped + ' not attempted. Remaining usage: ' + script.getRemainingUsage() + ', reserved: ' + usageFloor);
        break;
      }

      try {
        var result = buildInvoicePdf(invoiceIds[i], STAMP_PDF_FIELD_IN_BULK, SAVE_INDIVIDUAL_PDFS_TO_CABINET);

        // The ZIP entry name comes from the file object's `name`, which buildInvoicePdf()
        // already set to the client's convention - so add that object, not the raw
        // render output (whose name is auto-generated).
        var entry = result.pdfFile;

        if (ZIP_FROM_SAVED_FILES && result.fileId) {
          entry = file.load({ id: result.fileId });
        }

        pdfFiles.push(entry);
        generated.push({
          invoiceId: invoiceIds[i],
          trandoc: result.trandoc,
          fileName: result.fileName,
          fileId: result.fileId
        });
        renderedIds.push(invoiceIds[i]);
      } catch (e) {
        log.error('Error rendering invoice ' + invoiceIds[i], e);
        failed.push({ invoiceId: invoiceIds[i], message: e.message });
        // tobeprinted left untouched on failure so it's picked up again next run.
      }
    }

    if (!pdfFiles.length) {
      response.write('Could not generate any invoice PDFs. See the script execution log for details.');
      return;
    }

    var zipFile;
    try {
      zipFile = buildInvoiceZip(custId, pdfFiles, generated, failed, skipped);
    } catch (e) {
      log.error('Failed to build invoice ZIP', e);
      // Deliberately no clearToBePrinted() here - nothing was delivered, so nothing is done.
      response.write('Generated ' + pdfFiles.length + ' PDF(s) but could not build the ZIP: ' +
        e.message + '. No invoices were de-flagged, so you can safely retry.');
      return;
    }

    // Only now that the ZIP exists do we clear the flags.
    clearToBePrinted(renderedIds);

    log.audit('Bulk print complete', generated.length + ' zipped, ' + failed.length + ' failed, ' + skipped + ' deferred');

    response.writeFile({
      file: zipFile,
      isInline: false   // false => Content-Disposition: attachment, i.e. a real download
    });
  }

  function getBulkStopUsageFloor(nextRenderedCount) {
    var reserve = 100 + (nextRenderedCount * 12);

    if (SAVE_INDIVIDUAL_PDFS_TO_CABINET || STAMP_PDF_FIELD_IN_BULK || ZIP_FROM_SAVED_FILES) {
      reserve += 100;
    }

    return reserve;
  }

  /**
   * Wraps the generated PDFs in a single ZIP via N/compress. Entry names come from each
   * file object's `name`, so they land in the archive under the client's naming convention.
   *
   * `type` is set defensively: if compress.Type isn't exposed the way this account's version
   * expects, we omit it and let the module default (ZIP) apply rather than throwing.
   */
  function buildInvoiceZip(custId, pdfFiles, generated, failed, skipped) {
    var archiver = compress.createArchiver();

    for (var i = 0; i < pdfFiles.length; i++) {
      archiver.add({ file: pdfFiles[i] });
    }

    if (INCLUDE_ZIP_MANIFEST) {
      archiver.add({
        file: file.create({
          name: '_manifest.txt',
          fileType: file.Type.PLAINTEXT,
          contents: buildManifestText(custId, generated, failed, skipped)
        })
      });
    }

    var archiveOptions = { name: buildZipFileName(custId) };
    if (compress.Type && compress.Type.ZIP) archiveOptions.type = compress.Type.ZIP;

    var zipFile = archiver.archive(archiveOptions);

    if (SAVE_ZIP_TO_CABINET) {
      try {
        zipFile.folder = PDF_FOLDER_ID;
        log.audit('ZIP archived to file cabinet', 'File ID: ' + zipFile.save());
      } catch (e) {
        // A file-cabinet copy is a convenience, not the deliverable. Never let it block
        // the download the user is waiting on.
        log.error('Could not save ZIP copy to file cabinet', e);
      }
    }

    return zipFile;
  }

  /**
   * "Invoices - <Customer> - YYYY-MM-DD.zip", falling back to the internal id if the
   * customer name can't be read. Uses lookupFields (1 unit) rather than loading the record.
   */
  function buildZipFileName(custId) {
    var label = '';

    try {
      var values = search.lookupFields({
        type: 'customer',
        id: custId,
        columns: ['entityid']
      });
      label = sanitizeFileNamePart(values.entityid);
    } catch (e) {
      log.debug('Customer name lookup skipped for ZIP name', e);
    }

    if (!label) label = 'Customer ' + custId;

    var now = new Date();
    var stamp = now.getFullYear() + '-' +
      padTwo(now.getMonth() + 1) + '-' +
      padTwo(now.getDate());

    var name = tidyFileName('Invoices' + ZIP_NAME_SEPARATOR + label + ZIP_NAME_SEPARATOR + stamp);

    if (name.length > MAX_FILE_NAME_LENGTH) {
      name = name.substring(0, MAX_FILE_NAME_LENGTH).replace(/[_\-]+$/, '');
    }

    return name + '.zip';
  }

  function padTwo(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * Plain-text run summary bundled into the ZIP. Because the response is a file download the
   * user never sees an HTML page, so without this any partial run or per-invoice failure would
   * only be visible in the script execution log.
   */
  function buildManifestText(custId, generated, failed, skipped) {
    var lines = [];

    lines.push('Invoice PDF export');
    lines.push('Customer internal id: ' + custId);
    lines.push('Generated: ' + new Date().toString());
    lines.push('Script version: ' + SCRIPT_VERSION);
    lines.push('');
    lines.push('INCLUDED (' + generated.length + ')');
    lines.push('----------------------------------------');

    for (var i = 0; i < generated.length; i++) {
      lines.push('  ' + generated[i].fileName +
        '   [invoice id ' + generated[i].invoiceId +
        (generated[i].fileId ? ', file id ' + generated[i].fileId : '') + ']');
    }

    if (failed.length) {
      lines.push('');
      lines.push('FAILED (' + failed.length + ') - still flagged To Be Printed, retry the button');
      lines.push('----------------------------------------');
      for (var j = 0; j < failed.length; j++) {
        lines.push('  invoice id ' + failed[j].invoiceId + ': ' + failed[j].message);
      }
    }

    if (skipped > 0) {
      lines.push('');
      lines.push('NOT ATTEMPTED (' + skipped + ')');
      lines.push('----------------------------------------');
      lines.push('  The Suitelet reached its governance limit before these were reached.');
      lines.push('  They remain flagged To Be Printed - click the button again to continue.');
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Clears the native "To Be Printed" checkbox on each given invoice via submitFields
   * (inline field update, no full-record validation/posting-period checks). Failures
   * are logged per-invoice rather than thrown, so one bad record doesn't block the others.
   */
  function clearToBePrinted(invoiceIds) {
    for (var i = 0; i < invoiceIds.length; i++) {
      try {
        record.submitFields({
          type: record.Type.INVOICE,
          id: invoiceIds[i],
          values: {
            tobeprinted: false
          },
          options: {
            enableSourcing: false,
            ignoreMandatoryFields: true
          }
        });
      } catch (e) {
        log.error('Failed to clear tobeprinted on invoice ' + invoiceIds[i], e);
      }
    }
  }

  /**
   * Returns internal ids of the customer's invoices flagged "To Be Printed" - the same
   * single criterion native bulk print uses. Status is deliberately not filtered, so a
   * paid or closed invoice still prints if someone left the flag checked, exactly as
   * native behaves.
   */
  function getOpenInvoiceIdsForCustomer(custId) {
    var ids = [];

    var invSearch = search.create({
      type: search.Type.INVOICE,
      filters: [
        ['entity', 'anyof', custId],
        'AND', ['mainline', 'is', 'T'],
        'AND', ['tobeprinted', 'is', 'T']
      ],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'tranid', sort: search.Sort.ASC })
      ]
    });

    invSearch.run().each(function (result) {
      ids.push(result.getValue({ name: 'internalid' }));
      return true;
    });

    return ids;
  }

  // ---------------------------------------------------------------------
  // Unchanged helper functions from the original script
  // ---------------------------------------------------------------------

  function isCustomerChevronSortEnabled(customerId, jobId) {
    var checkboxFieldId = 'custentity_bc_sort_invoice_pdf';

    if (customerId && isCheckboxChecked('customer', customerId, checkboxFieldId)) {
      return true;
    }

    if (jobId && isCheckboxChecked('job', jobId, checkboxFieldId)) {
      return true;
    }

    return false;
  }

  function isCheckboxChecked(recordType, recordId, fieldId) {
    try {
      var values = search.lookupFields({
        type: recordType,
        id: recordId,
        columns: [fieldId]
      });

      return values[fieldId] === true || values[fieldId] === 'T';
    } catch (e) {
      log.debug('Customer sort checkbox lookup skipped', e);
      return false;
    }
  }

  function groupByOrderID(list, key) {
    return list.reduce(function (rv, x) {
      (rv[x[key]] = rv[x[key]] || []).push(x);
      return rv;
    }, {});
  }

  /**
   * Unchanged logic, now memoised per execution. This runs one transaction search per
   * applied billable line; without the cache a bulk run re-searched the same vendor bill
   * every time it appeared, which dominated governance usage.
   */
  function determineBillGrouping(transactionID, recordType) {
    recordType = recordType || 'vendorbill';

    if (!transactionID) {
      return {type: 'Other', tranid: '', entity: ''};
    }

    var cacheKey = recordType + ':' + String(transactionID);
    if (_billGroupingCache[cacheKey]) return _billGroupingCache[cacheKey];

    var grouping = '';
    var tranid = '';
    var entity = '';

    try {
      var columns = ['tranid', 'entity'];
      if (recordType === 'vendorbill') {
        columns.push('custbody4');
        columns.push('custbody5');
      }

      var fields = search.lookupFields({
        type: recordType,
        id: transactionID,
        columns: columns
      });

      tranid = fields.tranid || '';
      entity = getLookupTextValue(fields.entity);

      if (recordType !== 'vendorbill') {
        grouping = 'Other';
      } else if (isCheckedLookupValue(fields.custbody4)) {
        grouping = 'Subcontractor';
      } else if (isCheckedLookupValue(fields.custbody5)) {
        grouping = 'Rented Equipment';
      } else {
        grouping = 'Other';
      }
    } catch (e) {
      log.error('Bill grouping lookup failed for ' + recordType + ' ' + transactionID, e);
      grouping = 'Other';
    }

    _billGroupingCache[cacheKey] = {type: grouping, tranid: tranid, entity: entity};
    return _billGroupingCache[cacheKey];
  }

  function determineTimeGrouping(timeID) {
    var timeRecord = record.load({
      type: 'timebill',
      id: timeID,
    });
    var employeeID = timeRecord.getValue({ fieldId: 'employee' });

    var employeeRecord = record.load({
      type: 'employee',
      id: employeeID,
    });

    var isMaterialGrouping = employeeRecord.getValue({ fieldId: 'custentity10' });
    var isEquipmentGrouping = employeeRecord.getValue({ fieldId: 'custentity9' });
    var tranid = employeeRecord.getValue({ fieldId: 'tranid' });
    var entity = employeeRecord.getText({ fieldId: 'entity' });

    if (isMaterialGrouping) {
      return {type: 'Material', tranid: tranid, entity: entity};
    } else if (isEquipmentGrouping) {
      return {type: 'Equipment', tranid: tranid, entity: entity};
    } else {
      return {type: 'Labor', tranid: tranid, entity: entity};
    }
  }

  function groupAndSummarize(array, useChevronSort) {
    var sortOrder = ["Labor", "Material", "Subcontractor", "Equipment", "Rented Equipment", "Other"];

    var sortedArray = array.sort(function (a, b) {
      var groupComparison = sortOrder.indexOf(a.grouping) - sortOrder.indexOf(b.grouping);
      if (groupComparison !== 0) return groupComparison;

      var dateComparison = compareDates(a.billedDate, b.billedDate);
      if (dateComparison !== 0) return dateComparison;

      if (useChevronSort) {
        var employeeComparison = compareSortText(a.sortEmployee, b.sortEmployee);
        if (employeeComparison !== 0) return employeeComparison;

        var timeTypeComparison = getStraightOvertimeSort(a) - getStraightOvertimeSort(b);
        if (timeTypeComparison !== 0) return timeTypeComparison;

        var nameComparison = compareSortText(a.name, b.name);
        if (nameComparison !== 0) return nameComparison;
      }

      return (a.sortIndex || 0) - (b.sortIndex || 0);
    });

    var resultArray = [];
    var currentGroup = null;
    var groupTotal = 0;
    var markupTotal = 0;

    for (var i = 0; i < sortedArray.length; i++) {
      var item = sortedArray[i];
      var previtem = sortedArray[i - 1];

      if (currentGroup !== item.grouping) {
        if (currentGroup !== null) {
          if (previtem.disName) {
            var markamt = parseFloat(markupTotal);
            groupTotal = groupTotal + markamt;
            resultArray.push({
              type: "markup",
              name: previtem.disName,
              rate: previtem.disc + "%",
              amount: formatCurrency(markamt),
              grouping: currentGroup
            });
          }

          resultArray.push({
            type: "total",
            total: formatCurrency(groupTotal),
            grouping: currentGroup
          });
        }

        currentGroup = item.grouping;
        groupTotal = 0;
        markupTotal = 0;
      }

      resultArray.push(item);
      markupTotal += item.discAmt || 0;
      groupTotal += item.amount || 0;

      item.amount = formatCurrency(item.amount);
      item.qty = formatCurrency(item.qty);
      item.rate = formatCurrency(item.rate);
    }

    if (currentGroup !== null) {
      if (item.disName) {
        var markamt = parseFloat(markupTotal);
        groupTotal = groupTotal + markamt;
        resultArray.push({
          type: "markup",
          name: item.disName,
          rate: item.disc + "%",
          amount: formatCurrency(markamt),
          grouping: currentGroup
        });
      }

      resultArray.push({
        type: "total",
        total: formatCurrency(groupTotal),
        grouping: currentGroup
      });
    }

    return resultArray;
  }


  function formatCurrency(value) {
    if(!value) value = 0;

    var number = parseFloat(value);
    var currencyString = number.toFixed(2);
    var currencyParts = currencyString.split('.');
    var integerPart = currencyParts[0];
    var decimalPart = currencyParts[1];
    var withCommas = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    return withCommas + '.' + decimalPart;
  }

  function getBillingClass(employeeIds){
    var ids = normalizeIdList(employeeIds);

    if (ids.length) {
      var missingIds = [];

      for (var i = 0; i < ids.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(_billingClassCache, ids[i])) {
          missingIds.push(ids[i]);
        }
      }

      if (missingIds.length) loadBillingClassesForEmployeeIds(missingIds);
      return _billingClassCache;
    }

    if (_billingClassFullCacheLoaded) return _billingClassCache;

    loadBillingClassSearch([
      ["billingclass","noneof","@NONE@"]
    ], null);

    _billingClassFullCacheLoaded = true;
    return _billingClassCache;
  }

  function loadBillingClassesForEmployeeIds(employeeIds) {
    for (var i = 0; i < employeeIds.length; i++) {
      _billingClassCache[employeeIds[i]] = null;
    }

    loadBillingClassSearch([
      ["internalid","anyof",employeeIds],
      "AND",
      ["billingclass","noneof","@NONE@"]
    ], employeeIds);
  }

  function loadBillingClassSearch(filters, requestedIds) {
    var loaded = 0;

    try {
      var employeeSearchObj = search.create({
        type: "employee",
        filters: filters,
        columns:
        [
          search.createColumn({name: "internalid", label: "Internal ID"}),
          search.createColumn({name: "entityid", label: "Name"}),
          search.createColumn({name: "billingclass", label: "Billing Class"}),
          search.createColumn({name: "custentity10", label: "custentity10 "}),
          search.createColumn({name: "custentity9", label: "custentity9"})
        ]
      });

      employeeSearchObj.run().each(function(result){
        var id = String(result.getValue({name:'internalid'}));

        _billingClassCache[id] = [{
          id: id,
          employeeName: result.getValue({name: "entityid"}),
          class: result.getText({name: "billingclass"}),
          custentity10: result.getValue({name: 'custentity10'}),
          custentity9: result.getValue({name: 'custentity9'})
        }];

        loaded++;
        return true;
      });

      log.debug("employee billing classes loaded", loaded);
    } catch (e) {
      log.error('Employee billing-class search failed', e);

      if (requestedIds) {
        for (var i = 0; i < requestedIds.length; i++) {
          if (_billingClassCache[requestedIds[i]] === null) delete _billingClassCache[requestedIds[i]];
        }
      }
    }
  }

  function getTimeBillingClass(project, timeIds){
    var cacheKey = String(project || '');
    if (!_timeBillingCache[cacheKey]) _timeBillingCache[cacheKey] = {};

    var projectCache = _timeBillingCache[cacheKey];
    var ids = normalizeIdList(timeIds);

    if (ids.length) {
      var missingIds = [];

      for (var i = 0; i < ids.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(projectCache, ids[i])) {
          missingIds.push(ids[i]);
        }
      }

      if (missingIds.length) loadTimeBillingClasses(projectCache, project, missingIds);
      return projectCache;
    }

    // No project means the "customer anyof" filter below has nothing valid to match,
    // so skip the broad project search rather than letting it throw or return the account.
    if (!project || _timeBillingFullCacheLoaded[cacheKey]) return projectCache;

    loadTimeBillingClasses(projectCache, project, null);
    _timeBillingFullCacheLoaded[cacheKey] = true;

    return projectCache;
  }

  function loadTimeBillingClasses(projectCache, project, timeIds) {
    var requestedIds = normalizeIdList(timeIds);
    var filters;

    if (requestedIds.length) {
      for (var i = 0; i < requestedIds.length; i++) {
        projectCache[requestedIds[i]] = null;
      }

      filters = [
        ["internalid","anyof",requestedIds]
      ];

      if (project) {
        filters.push("AND");
        filters.push(["customer","anyof",project]);
      }
    } else {
      filters = [
        ["customer","anyof",project]
      ];
    }

    try {
      var loaded = 0;
      var timebillSearchObj = search.create({
        type: "timebill",
        filters: filters,
        columns:
        [
          search.createColumn({name: "internalid", label: "Internal ID"}),
          search.createColumn({name: "employee", label: "Employee"}),
          search.createColumn({name: "billingclass", label: "Billing Class"})
        ]
      });

      timebillSearchObj.run().each(function(result){
        var id = String(result.getValue({name:'internalid'}));

        projectCache[id] = [{
          id: id,
          class: result.getText({name: "billingclass"}),
          emp: result.getValue({name: 'employee'}),
          employeeName: result.getText({name: 'employee'})
        }];

        loaded++;
        return true;
      });

      log.debug("time billing classes loaded", loaded);
    } catch (e) {
      log.error('Time billing-class search failed', e);

      for (var j = 0; j < requestedIds.length; j++) {
        if (projectCache[requestedIds[j]] === null) delete projectCache[requestedIds[j]];
      }
    }
  }

  function safeGetText(rec, fieldId) {
    try {
      return rec.getText({fieldId: fieldId}) || '';
    } catch (e) {
      return '';
    }
  }

  function isChevronPdcOrNoble(jobId, jobText, entityText) {
    var values = [jobText, entityText];

    if (jobId) {
      addJobLookupValues(values, jobId);
    }

    var combinedText = normalizeSortText(values.join(' '));
    var isChevron = combinedText.indexOf('chevron') !== -1;
    var isPdcOrNoble = combinedText.indexOf('pdc') !== -1 || combinedText.indexOf('noble') !== -1;

    return isChevron && isPdcOrNoble;
  }

  function addJobLookupValues(values, jobId) {
    try {
      var jobFields = search.lookupFields({
        type: 'job',
        id: jobId,
        columns: ['entityid', 'parent']
      });

      addLookupText(values, jobFields.entityid);
      addLookupText(values, jobFields.parent);
    } catch (e) {
      log.debug('Chevron job lookup skipped', e);
    }
  }

  function getLookupTextValue(fieldValue) {
    var values = [];
    addLookupText(values, fieldValue);
    return values.join(' ');
  }

  function isCheckedLookupValue(value) {
    return value === true || value === 'T' || value === 'true';
  }

  function addLookupText(values, fieldValue) {
    if (!fieldValue) return;

    if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
      values.push(fieldValue);
      return;
    }

    if (Object.prototype.toString.call(fieldValue) === '[object Array]') {
      for (var i = 0; i < fieldValue.length; i++) {
        addLookupText(values, fieldValue[i]);
      }
      return;
    }

    if (fieldValue.text) values.push(fieldValue.text);
    else if (fieldValue.value) values.push(fieldValue.value);
  }


  function getEmployeeName(employeeMap, employeeId) {
  if (employeeId && employeeMap[employeeId] && employeeMap[employeeId][0]) {
    return employeeMap[employeeId][0].employeeName || employeeId;
  }

  return '';
}

function getTimeEmployeeName(timeMap, timeId) {
  if (timeId && timeMap[timeId] && timeMap[timeId][0]) {
    return timeMap[timeId][0].employeeName || timeMap[timeId][0].emp || '';
  }

  return '';
}

  function compareDates(a, b) {
    var dateA = getDateSortValue(a);
    var dateB = getDateSortValue(b);

    if (dateA === null && dateB === null) return 0;
    if (dateA === null) return 1;
    if (dateB === null) return -1;

    return dateA - dateB;
  }

  function getDateSortValue(dateValue) {
    if (!dateValue) return null;

    try {
      var parsedDate = format.parse({
        value: dateValue,
        type: format.Type.DATE
      });

      if (parsedDate && !isNaN(parsedDate.getTime())) {
        return parsedDate.getTime();
      }
    } catch (e) {
    }

    var fallbackDate = new Date(dateValue);
    return isNaN(fallbackDate.getTime()) ? null : fallbackDate.getTime();
  }

  function getStraightOvertimeSort(item) {
    var text = normalizeSortText((item.name || '') + ' ' + (item.memoID || ''));

    if (text.indexOf('double time') !== -1 || /(^|[^a-z0-9])d\.?t\.?([^a-z0-9]|$)/.test(text)) {
      return 2;
    }

    if (text.indexOf('overtime') !== -1 || text.indexOf('over time') !== -1 || /(^|[^a-z0-9])o\.?t\.?([^a-z0-9]|$)/.test(text)) {
      return 1;
    }

    return 0;
  }

  function compareSortText(a, b) {
    var textA = normalizeSortText(a);
    var textB = normalizeSortText(b);

    if (!textA && !textB) return 0;
    if (!textA) return 1;
    if (!textB) return -1;
    if (textA < textB) return -1;
    if (textA > textB) return 1;

    return 0;
  }

  function normalizeSortText(value) {
    if (value === null || value === undefined) return '';
    return String(value).toLowerCase().replace(/^\s+|\s+$/g, '');
  }


  return {
    onRequest: onRequest
  };
});
