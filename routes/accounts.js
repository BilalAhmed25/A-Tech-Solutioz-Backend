var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    router = express.Router(),
    checkAccess = require('../accessControl')
    { con } = require('../database')
;

router.use(bodyParser.urlencoded({ extended: true }));

router.get('/collect-fee', checkAccess(1, 2), function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/collectFee.html'))
})

router.get('/fee-collection-record', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/feeCollectionRecord.html'))
})

router.get('/manage-fee', checkAccess(1, 2), function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/manageFee.html'))
})

router.get('/manage-pay', checkAccess(1, 2), function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/managePay.html'))
})

router.get('/manage-expenses', checkAccess(1, 2), function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/manageExpenses.html'))
})

router.get('/fee-summary', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/feeSummary.html'))
})

router.post('/generateVoucher', function (req, res) {
    con.query("SELECT `VoucherNumber` FROM `VoucherRecords` WHERE `InstituteCode` = " + req.user.InstituteCode + " ORDER BY `VoucherNumber` DESC", function (err, result) {
        if (!err){
            con.query("INSERT INTO `VoucherRecords`(`InstituteCode`, `Dated`, `VoucherNumber`, `GeneratedFor`, `PaidFor`, `PayableAmount`, `Discount`, `ReceivedAmount`, `PaymentMethod`, `AcademicSession`, `GeneratedBy`) VALUES ('" + req.user.InstituteCode + "', '" + req.body.dated + "', '" + (result[0].VoucherNumber + 1) + "', '" + req.body.generatedFor + "', '" + req.body.paidFor + "', '" + req.body.payableAmount + "', '" + req.body.discount + "', '" + (req.body.payableAmount - req.body.discount) + "', 'Cash', '" + req.body.academicSession + "', '" + req.user.EmpID + "')", function (err, result1) {
                if (err){
                    res.json(err.sqlMessage);
                }
                else{
                    res.json({'VoucherNumber': result[0].VoucherNumber, 'operatorName': req.user.Name})
                }
            });
        }
    });
})

router.post('/getGeneratedReceipts', function (req, res) {
    var query = "SELECT VoucherRecords.*, UserBioData.Name, StudentsRecord.StudentsName, StudentsRecord.FatherName, StudentsRecord.Gender FROM `VoucherRecords` JOIN UserBioData ON GeneratedBy = StaffID JOIN StudentsRecord ON GRNumber = GeneratedFor WHERE VoucherRecords.InstituteCode = '" + req.user.InstituteCode + "' AND UserBioData.InstituteCode = '" + req.user.InstituteCode + "' AND StudentsRecord.InstituteCode = '" + req.user.InstituteCode + "' AND DATE(VoucherRecords.Dated) >= '" + req.body.dateFrom + "' AND DATE(VoucherRecords.Dated) <= '" + req.body.dateTill + "'";
    if(req.body.academicSession != ''){
        query += " AND `AcademicSession` = '" + req.body.academicSession + "'"
    }
    if(req.body.class != ''){
        query += " AND `ClassID` = '" + req.body.class + "'"
    }
    if(req.body.faculty != ''){
        query += " AND `Faculty` = '" + req.body.faculty + "'"
    }
    if(req.body.section != ''){
        query += " AND `Section` = '" + req.body.section + "'"
    }
    query += " ORDER BY VoucherNumber ASC";
    con.query(query, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getReceiptDetails', function (req, res) {
    con.query("SELECT `VoucherRecords`.*, `StudentsRecord`.`StudentsName`, `StudentsRecord`.`FatherName`, `UserBioData`.`Name` FROM `VoucherRecords` JOIN `StudentsRecord` ON `VoucherRecords`.`GeneratedFor` = `StudentsRecord`.`GRNumber` JOIN  `UserBioData` ON `UserBioData`.`StaffID` = `VoucherRecords`.`GeneratedBy` WHERE `VoucherNumber` = '" + req.body.voucherNumber + "' AND `VoucherRecords`.`InstituteCode` = " + req.user.InstituteCode + " AND `StudentsRecord`.`InstituteCode` = " + req.user.InstituteCode + " AND `UserBioData`.`InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getFeeBySession', function (req, res) {
    con.query("SELECT * FROM `FeeChart` WHERE `AcademicSession` = '" + req.body.academicSession + "' AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getFeeDetails', function (req, res) {
    con.query("SELECT * FROM `FeeChart` WHERE InstituteCode = " + req.user.InstituteCode + " AND AcademicSession = '" + req.body.academicSession + "' AND `ClassID` = '" + req.body.classOfAdmission + "' AND `Faculty` = '" + req.body.facultyOfAdmission + "';", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/searchFeeHistoryByGR', function (req, res) {
    con.query("SELECT * FROM `VoucherRecords` WHERE `AcademicSession` = '" + req.body.academicSessions + "' AND `InstituteCode` = " + req.user.InstituteCode + " AND GeneratedFor = " + ((req.body.Type === 'Student') ? req.user.GRNumber : req.body.studentGRNumber), function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getStudentDataByGR', function (req, res) {
    con.query("SELECT * FROM `StudentsRecord` JOIN `StudentClassesHistory` ON `StudentsRecord`.`InstituteCode` = `StudentClassesHistory`.`InstituteCode` AND `StudentsRecord`.`GRNumber` = `StudentClassesHistory`.`StudentGR` WHERE `StudentClassesHistory`.`StudentGR` = " + ((req.body.Type === 'Student') ? req.user.GRNumber : req.body.studentGRNumber) + " AND `StudentClassesHistory`.`InstituteCode` = " + req.user.InstituteCode + " AND `StudentClassesHistory`.`AcademicSession` = '" + req.body.academicSessions + "'", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

// router.post('/getDatabyGRNumber', function (req, res) {
//     con.query("SELECT * FROM `StudentsRecord` JOIN `StudentClassesHistory` ON `GRNumber` = `StudentGR` WHERE `StudentClassesHistory`.`InstituteCode` = " + req.user.InstituteCode + " AND `StudentGR` = " + req.body.grNumber, function (err, result) {
//         if (err){
//             res.json(err.sqlMessage);
//         }
//         else{
//             res.json(result)
//         }
//     });
// })

router.get('/getFeeTypes', function (req, res) {
    con.query("SELECT `FeeTypes` FROM `SoftwareConfiguration` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND AcademicSession = '" + req.query.academicSession + "' ORDER BY ID DESC", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.get('/getFeeTypesAndClassesList', function (req, res) {
    con.query("SELECT * FROM `SoftwareConfiguration` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND AcademicSession = '" + req.query.academicSession + "' ORDER BY ID DESC", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getStaffPayDetails', function (req, res) {
    var query = "SELECT * FROM `UserBioData` JOIN `UserLoginDetails` ON `UserBioData`.`StaffID` = `UserLoginDetails`.`EmpID` JOIN `StaffPayRecord` ON `StaffPayRecord`.`StaffID` = `UserBioData`.`StaffID` WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND TillDate IS NULL ";
    if(req.body.filter != 'all'){
        query += " AND EmploymentStatus = '" + req.body.filter + "'"
    }
    con.query(query, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getStaffPayRecords', function (req, res) {
    var query = "SELECT * FROM `UserBioData` JOIN `UserLoginDetails` ON `UserBioData`.`StaffID` = `UserLoginDetails`.`EmpID` JOIN `StaffPayRecord` ON `StaffPayRecord`.`StaffID` = `UserBioData`.`StaffID` WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `UserBioData`.`StaffID` = " + req.body.StaffID;
    con.query(query, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getStaffCurrentPay', function (req, res) {
    var query = "SELECT * FROM `UserBioData` JOIN `UserLoginDetails` ON `UserBioData`.`StaffID` = `UserLoginDetails`.`EmpID` JOIN `StaffPayRecord` ON `StaffPayRecord`.`StaffID` = `UserBioData`.`StaffID` WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `UserBioData`.`StaffID` = " + req.body.staffID + " AND TillDate = '0000-00-00'";
    con.query(query, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/updateStaffPay', function (req, res) {
    con.query("UPDATE `StaffPayRecord` SET `TillDate` = '" + moment(req.body.incrementDate).subtract(1, "days").format('YYYY-MM-DD') + "' WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `StaffID` = " + req.body.staffID + "; INSERT INTO `StaffPayRecord` (`InstituteCode`, `StaffID`, `Salary`, `FromDate`) VALUES('" + req.user.InstituteCode + "', '" + req.body.staffID + "', '" + req.body.newSalary + "', '" + req.body.incrementDate + "'); ", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/manageFeeAmount', async function (req, res) {
    let queries = "";
    for (const element of req.body.facultyOfAdmission) {
        queries += "DELETE FROM `FeeChart` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND AcademicSession = '" + req.body.academicSession + "' AND ClassID = " + req.body.classes + " AND Faculty = '" + element + "' AND FeeType = " + req.body.feeType + ";\n";
        queries += "INSERT INTO `FeeChart`(`InstituteCode`, `AcademicSession`, `ClassID`, `Faculty`, `FeeType`, `Amount`) VALUES (" + req.user.InstituteCode + ", '" + req.body.academicSession + "', " + req.body.classes + ", '" + element + "', " + req.body.feeType + ", " + req.body.amount + ");";
    }

    con.query(queries, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/deleteFeetype', async function (req, res) {
    if(req.body.feeType != 1){
        con.query("SELECT * FROM `VoucherRecords` WHERE JSON_CONTAINS(PaidFor, '{\"FeeType\": \"" + req.body.feeType + "\"}') AND InstituteCode = '" + req.user.InstituteCode + "' AND AcademicSession = '" + req.body.academicSession + "'", function (err, result) {
            if (!err) {
                if (result.length > 0) {
                    res.json('System cannot delete fee type that is used in generating voucher(s).')
                }
                else {
                    con.query("SELECT * FROM `SoftwareConfiguration` WHERE `InstituteCode` = '" + req.user.InstituteCode + "' AND `AcademicSession` = '" + req.body.academicSession + "'", function (err, result1) {
                        if (!err) {
                            con.query("UPDATE `SoftwareConfiguration` SET `FeeTypes` = '" + JSON.stringify(JSON.parse(result1[0].FeeTypes).filter(item => item.ID !== req.body.feeType)) + "' WHERE `InstituteCode` = '" + req.user.InstituteCode + "' AND `AcademicSession` = '" + req.body.academicSession + "'", function (err, result1) {
                                if (!err) {
                                    res.json('Success')
                                }
                                else{
                                    console.log(err)
                                }
                            });
                        }
                    });
                }
            }
        });
    }
    else{
        res.json('System cannot delete monthly fee.')
    }
})

router.post('/addNewFeeType', function (req, res) {
    con.query("UPDATE `SoftwareConfiguration` SET `FeeTypes`= '" + JSON.stringify(req.body.feeTypes) + "' WHERE `InstituteCode` = " + req.user.InstituteCode + " AND AcademicSession = '" + req.body.academicSession + "'", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/checkingExpenseByFilter', function (req, res) {
    con.query("SELECT `ExpenseRecord`.*, `UserBioData`.`Name` FROM `ExpenseRecord` JOIN `UserBioData` ON `UserBioData`.`StaffID` = `ExpenseRecord`.`UploadedBy` WHERE `Date` >= '" + req.body.dateFrom + "' AND `DATE` <= '" + req.body.dateTill + "' AND `ExpenseRecord`.`InstituteCode` = '" + req.user.InstituteCode + "'", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/addNewExpense', function (req, res) {
    con.query("INSERT INTO `ExpenseRecord`(`InstituteCode`, `Date`, `ExpenseType`, `Amount`, `Description`, `UploadedBy`) VALUES ('" + req.user.InstituteCode + "', '" + req.body.dated + "', '" + req.body.expenseTitle + "', '" + req.body.expenseAmount + "', '" + req.body.expenseDescription + "', '" + req.user.EmpID + "')", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/editExpense', function (req, res) {
    con.query("UPDATE `ExpenseRecord` SET `Date`='" +  req.body.editDated + "',`ExpenseType`='" +  req.body.editExpenseTitle + "',`Amount`='" +  req.body.editExpenseAmount + "',`Description`='" +  req.body.editExpenseDescription + "' WHERE `InstituteCode`= " + req.user.InstituteCode + " AND `ID` = " + req.body.editExpenseID, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/getExpenseDetails', function (req, res) {
    con.query("SELECT * FROM `ExpenseRecord` WHERE `InstituteCode`= " + req.user.InstituteCode + " AND `ID` = " + req.body.expenseID, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

module.exports = router;