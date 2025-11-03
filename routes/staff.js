var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    router = express.Router(),
    checkAccess = require('../accessControl')
    { con } = require('../database')
;
1
router.get('/browse-staff-members', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/browseStaff.html'))
})

router.get('/appoint-new-member', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/appointStaffMember.html'))
})

router.post('/updateStaffData', function (req, res) {
    con.query("UPDATE `UserBioData` SET `StaffID` = '" + req.body.staffID + "', `InstituteCode` = '" + req.user.InstituteCode + "', `Name` = '" + req.body.staffName + "', `FatherName` = '" + req.body.fatherName + "', `CityOfBirth` = '" + req.body.cityOfBirth + "', `ContactNumber` = '" + req.body.contactNumber + "', `ResidentialAddress` = '" + req.body.residentialAddress + "', `Gender` = '" + req.body.gender + "', `DateOfBirth` = '" + req.body.dateOfBirth + "', `AppointmentDate` = '" + req.body.appointmentDate + "', `Qualification` = '" + req.body.qualification + "', `Nationality` = '" + req.body.nationality + "', `Religion` = '" + req.body.religion + "', `MotherTongue` = '" + req.body.motherTongue + "', `MaritalStatus` = '" + req.body.maritalStatus + "', `Designation` = '" + req.body.designation + "' WHERE `StaffID` = '" + req.body.staffID + "' AND `InstituteCode` = '" + req.user.InstituteCode + "'; UPDATE `UserLoginDetails` SET `UserEmail` = '" + req.body.email + "' WHERE `EmpID` = " + req.body.staffID + " AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/disableStaffProfile', function (req, res) {
    con.query("UPDATE `UserLoginDetails` SET `DeactivationDate` = '" + req.body.profileDisableDate + "', `EmploymentStatus` = 'Deactivated', `DisableReason` = '" + req.body.disableReason + "' WHERE `EmpID` = " + req.body.disableStaffID + " AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/appointNewStaff', function (req, res) {
    con.query("INSERT INTO `UserBioData`(`StaffID`, `InstituteCode`, `Name`, `FatherName`, `CityOfBirth`, `CNIC`, `ContactNumber`, `ResidentialAddress`, `Gender`, `DateOfBirth`, `AppointmentDate`, `Qualification`, `Nationality`, `Religion`, `MotherTongue`, `MaritalStatus`, `Designation`) VALUES ('" + req.body.StaffID + "', " + req.user.InstituteCode + ", '" + req.body.staffName + "', '" + req.body.fatherName + "', '" + req.body.cityOfBirth + "', '" + req.body.cnicNumber + "', '" + req.body.contactNumber + "', '" + req.body.residentialAddress + "', '" + req.body.gender + "', '" + req.body.dateOfBirth + "', '" + req.body.appointmentDate + "', '" + req.body.qualification + "', '" + req.body.nationality + "', '" + req.body.religion + "', '" + req.body.motherTongue + "', '" + req.body.maritalStatus + "', '" + req.body.designation + "'); INSERT INTO `StaffPayRecord` (`InstituteCode`, `StaffID`, `FromDate`) VALUES(" + req.user.InstituteCode + ", '" + req.body.StaffID + "', '" + req.body.appointmentDate + "'); INSERT INTO `UserLoginDetails` (`EmpID`, `InstituteCode`, `UserEmail`) VALUES('" + req.body.StaffID + "', " + req.user.InstituteCode + ", '" + req.body.email + "');", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.get('/getUpcomingStaffID', function (req, res) {
    con.query("SELECT `StaffID` FROM UserBioData WHERE `InstituteCode` = '" + req.user.InstituteCode + "' ORDER BY `UserBioData`.`StaffID` DESC", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

module.exports = router;