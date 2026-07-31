/**
* @NApiVersion 2.x
* @NScriptType Suitelet
* @NModuleScope SameAccount
*/

define(['N/render', 'N/record', 'N/xml', 'N/file', 'N/task', 'N/search', 'N/runtime', 'N/url', 'N/config', 'N/format'], function(render, record, xml, file, task, search, runtime, url, config, format) {
  function onRequest(context) {
    
    var response = context.response;
    
    if (context.request.method == 'GET'){
      
      var recId = context.request.parameters.recId;
      log.debug('recId', recId)
      var finalArray = [];
      
      var newRecord = record.load({type: 'invoice', id: recId});
      var trandoc = newRecord.getText({fieldId: 'tranid'})
      var job = newRecord.getValue({fieldId: 'job'})

      var empbillingClass = getBillingClass();
      log.debug('empbillingClass', empbillingClass)
      // var date = newRecord.getText({fieldId: 'trandate'})
      
      // Capture Billable Items from the 'itemcost' sublist
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
        var itemAmount = newRecord.getSublistValue({
          sublistId: 'item',
          fieldId: 'amount',
          line: i,
        });
        var grouping = '';
        if  (custcol_bc_employee){
        if (empbillingClass[custcol_bc_employee]) {
          //   var emprec = record.load({type: "employee", id: empid})
          var billingclass = empbillingClass[custcol_bc_employee][0].class;
          var isMaterialGrouping =  empbillingClass[custcol_bc_employee][0].custentity10;
          var isEquipmentGrouping = empbillingClass[custcol_bc_employee][0].custentity9;
          if (isMaterialGrouping) grouping = 'Material'
          else if (isEquipmentGrouping) grouping = 'Equipment'
          else grouping = 'Labor'

          item = billingclass;
        }else{
          grouping = "Other";
          item = billingclass;
        }
        }else{
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
          }else{
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
            grouping: group
          };
          if(urlcode.indexOf("/cardchrg.nl") != -1) {
             expenseData.name = expenseMemoID;
             expenseData.memoID = '';
          }
          log.audit('expenseData', expenseData)
          
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
          log.audit('timeQty', timeQty)
          
          if(timeQty.indexOf(":")!= -1){
            var parts = timeQty.split(":");
            var min = parseFloat(parts[1])/60;
            log.audit('min', min)
            if (min == 0) min = 00;
            // else parseInt(min, 2);
            log.audit('min', min)
            
            timeQty = parseFloat(parts[0]) + parseFloat(min);
            log.audit('timeQty', timeQty)
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
          log.debug("empid", empid)
          
          var billingclass = '';
          var group = '';

          if (timeID && empbillingTime[timeID]) {
            billingclass = empbillingTime[timeID][0].class;
          }
          
          
          if (empid && empbillingClass[empid]) {
            
            if (!billingclass) billingclass = empbillingClass[empid][0].class;
            var isMaterialGrouping =  empbillingClass[empid][0].custentity10;
            var isEquipmentGrouping = empbillingClass[empid][0].custentity9;
            if (isMaterialGrouping) group = 'Material'
            else if (isEquipmentGrouping) group = 'Equipment'
            else group = 'Labor'
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
            grouping: group
          };
          
          finalArray.push(timeData);
        }
      }
      
      
      
      // Log captured data
      var finalArray = groupAndSummarize(finalArray);
      log.debug('Final Array', finalArray);
      
      
      var xmlTemplateFile = file.load({
        id: 7618
      }).getContents();

      var subrec = record.load({type: 'subsidiary', id: 1})
      var logo = subrec.getValue('logo')

      if (logo) {
        var fileUrl = file.load({id: logo}).url;
        fileUrl = fileUrl.replace(/&/g, "&amp;")
        log.debug('fileUrl', fileUrl)
        xmlTemplateFile = xmlTemplateFile.replace('${logoURL}', fileUrl);
      }

      var renderer = render.create();

      renderer.addRecord({
        templateName: 'record', // Alias used in the template
        record: newRecord
      });

      // Check if any items have a tranid
      var hasREM = false;
      for (var i = 0; i < finalArray.length; i++) {
        if (finalArray[i].tranid && finalArray[i].tranid !== '') {
          hasREM = true;
          break;
        }
      }

      renderer.addCustomDataSource({
        format:render.DataSource.OBJECT,
        alias: 'results',
        data: {
          results: finalArray,
          hasREM: hasREM
        }
      });
      

      renderer.templateContent = xmlTemplateFile;
      
      var coverfile = renderer.renderAsPdf();
      
      var pdfFile = file.create({
        name: trandoc + '.pdf',
        fileType: file.Type.PDF,
        contents: coverfile.getContents(),
        encoding: file.Encoding.UTF8,
        folder: 2654 // Replace with the internal ID of the desired folder in the File Cabinet
      });
      
      // Save the file to the NetSuite File Cabinet
      var fileId = pdfFile.save();
      log.debug('PDF Saved', 'File ID: ' + fileId);
      
      try {
              var newRecord = record.load({type: 'invoice', id: recId});
            newRecord.setValue('custbody_bc_pdf_file',fileId )
         newRecord.save();
      } catch (error) {
        response.writeFile({
        file: coverfile,
        isInline: true
      });
        log.error('error', error)
      }

      
      
      response.writeFile({
        file: coverfile,
        isInline: true
      });
    }
  }
  
  function groupByOrderID(list, key){
    return list.reduce(function(rv, x) {
      (rv[x[key]] = rv[x[key]] || []).push(x);
      return rv;
    }, {});
  }
  
  function determineBillGrouping(transactionID, recordType) {
    recordType = recordType || 'vendorbill'; // Default to vendorbill if no recordType is provided
    var grouping = '';
    var isSubcontractor = '';
    var isRentedEquipment = '';
    var tranid = '';
    var entity = '';
    
    var transactionSearchObj = search.create({
      type: "transaction",
      filters:
      [
        ["internalid","anyof",transactionID], 
        "AND", 
        ["mainline","is","T"]
      ],
      columns:
      [
        search.createColumn({name: "tranid", label: "Document Number"}),
        search.createColumn({name: "entity", label: "Name"}),
        search.createColumn({name: "custbody4", label: "Subcontractor"}),
        search.createColumn({name: "custbody5", label: "Rented Equipment"})
      ]
    });
    var searchResultCount = transactionSearchObj.runPaged().count;
    log.debug("transactionSearchObj result count",searchResultCount);
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
    }else{
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
  
  function groupAndSummarize(array) {
    
    var sortOrder = ["Labor", "Material", "Subcontractor", "Equipment", "Rented Equipment", "Other"];
    
    var sortedArray = array.sort(function (a, b) {
      // Sort by grouping
      var groupComparison = sortOrder.indexOf(a.grouping) - sortOrder.indexOf(b.grouping);
      if (groupComparison !== 0) {
        return groupComparison;
      }
      
      // If grouping is the same, sort by billedDate
      var dateA = new Date(a.billedDate);
      var dateB = new Date(b.billedDate);
      return dateA - dateB;
    });
    
    
    // Step 2: Group and add summaries
    var resultArray = [];
    var currentGroup = null;
    var groupTotal = 0;
    var markupTotal = 0;
    
    for (var i = 0; i < sortedArray.length; i++) {
      var item = sortedArray[i];
      var previtem = sortedArray[i-1];
      
      // If new grouping is encountered, add the summary for the previous group
      if (currentGroup !== item.grouping) {
        if (currentGroup !== null) {
          if (previtem.disName) {
            
            var markamt = parseFloat(markupTotal);
            groupTotal = groupTotal + markamt
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
        
        // Reset for the new group
        currentGroup = item.grouping;
        groupTotal = 0;
        markupTotal = 0;
      }
      
      // Add the current item to the result
      resultArray.push(item);
      markupTotal += item.discAmt || 0;
      
      // Accumulate the total for the group
      groupTotal += item.amount || 0;
      
      item.amount = formatCurrency(item.amount);
      item.qty = formatCurrency(item.qty);
      item.rate = formatCurrency(item.rate);
    }
    
    // Add the last group summary
    if (currentGroup !== null) {
      
      if (item.disName) {
        
        var markamt = parseFloat(markupTotal)
        groupTotal = groupTotal + markamt
        resultArray.push({
          type: "markup",
          name: item.disName,
          rate: item.disc + "%",
          amount:formatCurrency(markamt),
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
    // Ensure the value is a number
    if(!value) value = 0;
    
    
    const number = parseFloat(value);
    
    // Convert number to a string with fixed two decimal places
    const currencyString = number.toFixed(2);
    
    // Split the number into integer and decimal parts
    const [integerPart, decimalPart] = currencyString.split('.');
    
    // Add commas to the integer part
    const withCommas = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    
    // Return formatted string with currency symbol and comma separation
    return withCommas + '.' + decimalPart;
  }
  
  function getBillingClass(){
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
        class: result.getText({name: "billingclass"}),
        custentity10: result.getValue({name: 'custentity10'}),
        custentity9: result.getValue({name: 'custentity9'})
      })  
      
      return true;
    });
    return groupByOrderID(billingArray,'id')
  }

  function getTimeBillingClass(project){
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
        emp: result.getValue({name: 'employee'})
      })  
      
      return true;
    });
    return groupByOrderID(billingArray,'id')
  }
  
  
  return {
    onRequest: onRequest
  };
});