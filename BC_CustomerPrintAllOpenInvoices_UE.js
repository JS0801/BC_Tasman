/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 *
 * Deploy on: Customer record only.
 *
 * Adds a "Print All Open Invoices" button to the Customer record view. Clicking it
 * opens the existing Detailed invoice-PDF Suitelet (customscript_bc_sl_print_invoice_pdf,
 * script record 2462) in bulk mode via a custId parameter - that Suitelet finds all open
 * invoices for the customer, renders each with the same template used for single-invoice
 * printing, and merges them into one PDF (see Tasman_SL_Print_invoice_PDF.js).
 */

define(['N/url'], function (url) {

  function beforeLoad(context) {
    if (context.type !== context.UserEventType.VIEW) return;

    var form = context.form;
    var custId = context.newRecord.id;

    if (!custId) return; // record hasn't been saved yet, nothing to print

    var scriptUrl = url.resolveScript({
      scriptId: 'customscript_bc_sl_print_invoice_pdf', // record 2462 - "BC | SL | Print Invoice PDF (Detailed)"
      deploymentId: 'customdeploy1'
    });

    var buttonScript = "window.open('" + scriptUrl + "&custId=" + custId + "', '_blank');";

    form.addButton({
      id: 'custpage_print_all_open_invoices',
      label: 'Print All Open Invoices',
      functionName: buttonScript
    });
  }

  return {
    beforeLoad: beforeLoad
  };
});