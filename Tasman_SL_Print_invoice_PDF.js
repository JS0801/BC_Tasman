/**
* @NApiVersion 2.x
* @NScriptType Suitelet
* @NModuleScope SameAccount
*
* Reformatted from the original single-invoice "Print BC PDF" Suitelet.
* Same script/deployment now supports two modes via URL parameters:
*
*   ?recId=<invoiceId>   -> ORIGINAL behavior, unchanged: renders + streams one invoice PDF,
*                           saves it to the file cabinet, stamps custbody_bc_pdf_file.
*
*   ?custId=<customerId> -> Finds all OPEN invoices for that customer, renders each one
*                           with the exact same logic/template as above, then merges them into
*                           a single PDF (like native NetSuite bulk print) and streams the result.
*                           Each invoice that renders successfully then has its "To Be Printed"
*                           (tobeprinted) checkbox cleared, so clicking the button again only
*                           picks up invoices that are newly flagged since the last run.
*
* NOTE on which invoices are picked up: getOpenInvoiceIdsForCustomer() filters solely on
* tobeprinted = T (the native "To Be Printed" flag), matching how native bulk print
* selects documents. Transaction status is not considered.
*/

define(['N/render', 'N/record', 'N/xml', 'N/file', 'N/task', 'N/search', 'N/runtime', 'N/url', 'N/config', 'N/format'], function(render, record, xml, file, task, search, runtime, url, config, format) {

  // ---------------------------------------------------------------------
  // Per-execution caches. In single-invoice mode these are populated once and
  // behave exactly as before. In bulk mode they stop us from re-running the same
  // account-wide lookups for every invoice, which is where most of the governance
  // was going (getBillingClass alone is a full employee search per invoice).
  // ---------------------------------------------------------------------
  var _billingClassCache = null;
  var _timeBillingCache = {};
  var _templateCache = null;

  var SCRIPT_VERSION = 'v9-2026-07-29-clear-tobeprinted';

  function onRequest(context) {

    log.audit('Script version', SCRIPT_VERSION);

    var response = context.response;

    if (context.request.method !== 'GET') return;

    var recId = context.request.parameters.recId;
    var custId = context.request.parameters.custId;

    try {
      if (recId) {
        // ---- original single-invoice behavior, unchanged ----
        var result = buildInvoicePdf(recId, true);
        response.writeFile({
          file: result.file,
          isInline: true
        });
        return;
      }

      if (custId) {
        // ---- bulk print all open invoices for a customer ----
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
   *        with the generated PDF's file id (original single-invoice behavior).
   * @param {boolean} asXmlString - if true, skips PDF generation and file cabinet save
   *        entirely, returning the populated XML string for <pdfset> merging in bulk mode.
   * @returns {{trandoc: string, file: File, fileId: number}} or {{trandoc, xmlString}}
   */
  function buildInvoicePdf(recId, stampInvoice, asXmlString) {

    log.debug('recId', recId);
    var finalArray = [];

    var newRecord = record.load({type: 'invoice', id: recId});
    var trandoc = newRecord.getText({fieldId: 'tranid'});
    var job = newRecord.getValue({fieldId: 'job'});
    var customer = newRecord.getValue({fieldId: 'entity'});
    var useChevronSort = isCustomerChevronSortEnabled(customer, job);
    log.debug('useChevronSort', useChevronSort);

    var empbillingClass = getBillingClass();
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
        if (urlcode.indexOf("/cardchrg.nl") != -1) {
          expenseData.name = expenseMemoID;
          expenseData.memoID = '';
        }
        log.audit('expenseData', expenseData);

        finalArray.push(expenseData);
      }
    }

    var empbillingTime = getTimeBillingClass(job);
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

        // var grouping = determineTimeGrouping(timeID);
        // var tranid = grouping.tranid;
        // var group = grouping.type;
        // var entity = grouping.entity;

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
        id: 7618
      }).getContents();

      var subrec = record.load({type: 'subsidiary', id: 1});
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

    // Bulk mode: hand back the populated XML so the caller can wrap every invoice
    // in a single <pdfset> and render once. Avoids creating a file cabinet PDF per
    // invoice, which SuiteScript has no API to merge anyway.
    if (asXmlString) {
      return { trandoc: trandoc, xmlString: renderer.renderAsString() };
    }

    var coverfile = renderer.renderAsPdf();

    var pdfFile = file.create({
      name: trandoc + '.pdf',
      fileType: file.Type.PDF,
      contents: coverfile.getContents(),
      encoding: file.Encoding.UTF8,
      folder: 2654 // Replace with the internal ID of the desired folder in the File Cabinet
    });

    var fileId = pdfFile.save();
    log.debug('PDF Saved', 'File ID: ' + fileId);

    if (stampInvoice) {
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

    return { trandoc: trandoc, file: coverfile, fileId: fileId };
  }

  /**
   * Finds all open invoices for a customer, renders each one to XML using the same
   * logic/template as single-invoice mode, wraps them all in a BFO <pdfset>, and renders
   * that once into a single merged PDF. Every invoice that makes it into the merged PDF
   * then has its "To Be Printed" checkbox cleared, so a repeat click of the button only
   * picks up invoices flagged since the last run instead of reprinting everything.
   *
   * SuiteScript has no PDF-merge API (render.mergePdfs does not exist) - <pdfset> is the
   * supported way to combine multiple rendered documents into one file.
   */
  function printAllOpenInvoicesForCustomer(context, custId) {
    var response = context.response;

    var invoiceIds = getOpenInvoiceIdsForCustomer(custId);

    if (!invoiceIds.length) {
      response.write('No open invoices found for this customer.');
      return;
    }

    log.audit('Bulk print starting', invoiceIds.length + ' open invoices for customer ' + custId);

    var script = runtime.getCurrentScript();
    var xmlParts = [];
    var renderedIds = [];

    for (var i = 0; i < invoiceIds.length; i++) {
      // Each invoice costs roughly 60-90 governance units to render, plus another
      // ~10 for the submitFields call that clears tobeprinted below. A Suitelet
      // (1000 units) realistically handles about a dozen. Stop cleanly with a
      // partial PDF rather than dying mid-run and returning nothing.
      if (script.getRemainingUsage() < 160) {
        log.audit('Governance limit reached', 'Rendered ' + renderedIds.length + ' of ' + invoiceIds.length + ' invoices');
        break;
      }

      try {
        var result = buildInvoicePdf(invoiceIds[i], false, true);
        xmlParts.push(stripXmlPreamble(result.xmlString));
        renderedIds.push(invoiceIds[i]);
      } catch (e) {
        log.error('Error rendering invoice ' + invoiceIds[i], e);
        // Left tobeprinted untouched on failure so it's picked up again next run.
      }
    }

    if (!xmlParts.length) {
      response.write('Could not generate any invoice PDFs.');
      return;
    }

    var setXml = '<?xml version="1.0"?>\n' +
      '<!DOCTYPE pdfset PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">\n' +
      '<pdfset>' + xmlParts.join('') + '</pdfset>';

    var mergedPdf = render.xmlToPdf({ xmlString: setXml });

    mergedPdf.name = 'Open_Invoices_' + custId + '.pdf';

    // Clear "To Be Printed" only on invoices that actually made it into this PDF,
    // so a re-click of the button won't pick these back up. If the merge above had
    // thrown, we'd have exited before this point and left every flag untouched.
    clearToBePrinted(renderedIds);

    response.writeFile({
      file: mergedPdf,
      isInline: true
    });
  }

  /**
   * Clears the native "To Be Printed" checkbox on each given invoice via submitFields
   * (inline field update, no full-record validation/posting-period checks). Failures
   * are logged per-invoice rather than thrown, so one bad record doesn't block the
   * others or the PDF the user is about to receive.
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
   * Each rendered invoice comes back as a full standalone document. For <pdfset> the
   * inner entries must be bare <pdf>...</pdf> elements, so drop the XML declaration
   * and DOCTYPE from each one.
   */
  function stripXmlPreamble(xmlString) {
    return String(xmlString)
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/^\s+|\s+$/g, '');
  }

  /**
   * Returns internal ids of the customer's invoices flagged "To Be Printed" - the same
   * single criterion native bulk print uses. Status is deliberately not filtered, so a
   * paid or closed invoice still prints if someone left the flag checked, exactly as
   * native behaves.
   *
   * Invoices in subsidiary 4 (Construction Earthwork) are excluded from this bulk pull.
   * This filter lives only here - it does not touch buildInvoicePdf() or the recId/
   * single-invoice path, so the existing "Print BC PDF" button/UE that calls this
   * Suitelet with ?recId= is unaffected and can still print a Construction Earthwork
   * invoice directly when someone opens it.
   */
  function getOpenInvoiceIdsForCustomer(custId) {
    var ids = [];

    var invSearch = search.create({
      type: search.Type.INVOICE,
      filters: [
        ['entity', 'anyof', custId],
        'AND', ['mainline', 'is', 'T'],
        'AND', ['tobeprinted', 'is', 'T'],
        'AND', ['subsidiary', 'noneof', '4']
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

  function determineBillGrouping(transactionID, recordType) {
    recordType = recordType || 'vendorbill';
    var grouping = '';
    var isSubcontractor = '';
    var isRentedEquipment = '';
    var tranid = '';
    var entity = '';

    var transactionSearchObj = search.create({
      type: "transaction",
      filters: [
        ["internalid", "anyof", transactionID],
        "AND",
        ["mainline", "is", "T"]
      ],
      columns: [
        search.createColumn({name: "tranid", label: "Document Number"}),
        search.createColumn({name: "entity", label: "Name"}),
        search.createColumn({name: "custbody4", label: "Subcontractor"}),
        search.createColumn({name: "custbody5", label: "Rented Equipment"})
      ]
    });
    var searchResultCount = transactionSearchObj.runPaged().count;
    log.debug("transactionSearchObj result count", searchResultCount);
    transactionSearchObj.run().each(function(result){

      isSubcontractor = result.getValue({ name: 'custbody4' });
      isRentedEquipment = result.getValue({ name: 'custbody5' });
      tranid = result.getValue({ name: 'tranid' });
      entity = result.getText({ name: 'entity' });

      return true;
    });

    if (isSubcontractor) {
      grouping = 'Subcontractor';
    } else if (isRentedEquipment) {
      grouping = 'Rented Equipment';
    } else {
      grouping = 'Other';
    }

    return {type: grouping, tranid: tranid, entity: entity};
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

    const number = parseFloat(value);
    const currencyString = number.toFixed(2);
    const [integerPart, decimalPart] = currencyString.split('.');
    const withCommas = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    return withCommas + '.' + decimalPart;
  }

  function getBillingClass(){
    if (_billingClassCache !== null) return _billingClassCache;

    var billingArray = []
    var employeeSearchObj = search.create({
      type: "employee",
      filters:
      [
        ["billingclass","noneof","@NONE@"]
      ],
      columns:
      [
        search.createColumn({name: "internalid", label: "Internal ID"}),
        search.createColumn({name: "entityid", label: "Name"}),
        search.createColumn({name: "billingclass", label: "Billing Class"}),
        search.createColumn({name: "custentity10", label: "custentity10 "}),
        search.createColumn({name: "custentity9", label: "custentity9"})
      ]
    });

    var searchResultCount = employeeSearchObj.runPaged().count;
    log.debug("employeeSearchObj result count",searchResultCount);
    employeeSearchObj.run().each(function(result){

      billingArray.push({
        id: result.getValue({name:'internalid'}),
        employeeName: result.getValue({name: "entityid"}),
        class: result.getText({name: "billingclass"}),
        custentity10: result.getValue({name: 'custentity10'}),
        custentity9: result.getValue({name: 'custentity9'})
      })

      return true;
    });

    _billingClassCache = groupByOrderID(billingArray,'id');
    return _billingClassCache;
  }

  function getTimeBillingClass(project){
    var cacheKey = String(project || '');
    if (_timeBillingCache[cacheKey]) return _timeBillingCache[cacheKey];

    // No project means the "customer anyof" filter below has nothing valid to match,
    // so skip the search entirely rather than letting it throw or return the account.
    if (!project) {
      _timeBillingCache[cacheKey] = {};
      return _timeBillingCache[cacheKey];
    }

    var billingArray = []
    var timebillSearchObj = search.create({
      type: "timebill",
      filters:
      [
        ["customer","anyof",project]
      ],
      columns:
      [
        search.createColumn({name: "internalid", label: "Internal ID"}),
        search.createColumn({name: "employee", label: "Employee"}),
        search.createColumn({name: "billingclass", label: "Billing Class"})
      ]
    });
    var searchResultCount = timebillSearchObj.runPaged().count;
    log.debug("timebillSearchObj result count",searchResultCount);
    timebillSearchObj.run().each(function(result){

      billingArray.push({
        id: result.getValue({name:'internalid'}),
        class: result.getText({name: "billingclass"}),
        emp: result.getValue({name: 'employee'}),
        employeeName: result.getText({name: 'employee'})
      })

      return true;
    });

    _timeBillingCache[cacheKey] = groupByOrderID(billingArray,'id');
    return _timeBillingCache[cacheKey];
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