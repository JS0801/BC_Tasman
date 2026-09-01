/**
 * @NApiVersion 2.x
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Submits the CSV import that clears Invoice To Be Printed after the browser bulk PDF
 * export has saved its successful-invoice CSV to the file cabinet.
 */

define(['N/runtime', 'N/file', 'N/task'], function (runtime, file, task) {

  var PARAM_CSV_FILE_ID = 'custscript_bc_inv_csv_file_id';
  var PARAM_CSV_IMPORT_MAPPING_ID = 'custscript_bc_inv_csv_mapping_id';

  function execute(context) {
    var script = runtime.getCurrentScript();
    var csvFileId = script.getParameter({ name: PARAM_CSV_FILE_ID });
    var mappingId = script.getParameter({ name: PARAM_CSV_IMPORT_MAPPING_ID });
    var importTaskName = 'Clear Invoice To Be Printed';

    log.debug('csvFileId', csvFileId)
    log.debug('csvFileId', csvFileId)

    if (!csvFileId) throw new Error('Missing required parameter ' + PARAM_CSV_FILE_ID);
    if (!mappingId) throw new Error('Missing required parameter ' + PARAM_CSV_IMPORT_MAPPING_ID);

    var csvFile = file.load({
      id: csvFileId
    });

    var csvTask = task.create({
      taskType: task.TaskType.CSV_IMPORT
    });

    csvTask.mappingId = mappingId;
    csvTask.importFile = csvFile;
    csvTask.name = importTaskName;

    var csvTaskId = csvTask.submit();

    log.audit('CSV import submitted', {
      csvTaskId: csvTaskId,
      csvFileId: csvFileId,
      mappingId: mappingId,
      importTaskName: importTaskName
    });
  }

  return {
    execute: execute
  };
});
