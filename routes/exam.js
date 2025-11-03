var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    queryString = require('querystring');
    router = express.Router()
    { con } = require('../database')
;

router.use(bodyParser.urlencoded({ extended: true }));

router.get('/manage-exam', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/createExam.html'))
})

router.get('/commence-exam', function (req, res) {
    if(req.user.PresentClass == 'undefined'){
        res.sendFile(path.join(__dirname,'../views/administrator/onlineExam.html'))
    }
    else{
        res.redirect('/not-authorized')
    }
})

router.get('/progress-report', function (req, res) {
    if(req.user.PresentClass == 'undefined'){
        res.sendFile(path.join(__dirname,'../views/administrator/onlineExam.html'))
    }
    else{
        res.redirect('/not-authorized')
    }
})

router.get('/progress-history', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/progressHistory.html'))
})

router.get('/upload-marks', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/uploadMarks.html'))
})

router.get('/my-progress', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/myProgress.html'))
})

router.post('/createExam', function (req, res) {
    var data = queryString.parse(req.body.data)
    var subExamsJSON = [];
    var subjects = data.subjectsForExam;
    if(!Array.isArray(subjects)){
        subjects = Array.from(subjects)
    }
    subjects.forEach(element => {
        const startDate = data[`examStartDate${element}`];
        const endDate = data[`examEndDate${element}`];
        const passingMarks = parseInt(data[`examPassingMarks${element}`]);
        const totalMarks = parseInt(data[`examTotalMarks${element}`]);

        const result = JSON.stringify({
            SubjectID: element,
            StartDate: startDate,
            EndDate: endDate,
            PassingMarks: passingMarks,
            TotalMarks: totalMarks
        });
        subExamsJSON.push(JSON.parse(result))
    });
    const dates = subExamsJSON.reduce((acc, obj) => {
        if (!acc.smallestStartDate || obj.StartDate < acc.smallestStartDate) {
            acc.smallestStartDate = obj.StartDate;
        }
        if (!acc.largestEndDate || obj.EndDate > acc.largestEndDate) {
            acc.largestEndDate = obj.EndDate;
        }

        acc.totalPassingMarks += parseInt(obj.PassingMarks);
        acc.totalTotalMarks += parseInt(obj.TotalMarks);
        return acc;
    }, { smallestStartDate: null, largestEndDate: null, totalPassingMarks: 0, totalTotalMarks: 0 });
    
    con.query("INSERT INTO `Exams`(`InstituteCode`, `AcademicSession`, `From`, `Till`, `ExamClass`, `Faculty`, `ExamTitle`, `SubExams`, `TotalMarks`, `PassingMarks`, `CreatedBy`) VALUES (" + req.user.InstituteCode + ", '" + req.body.AcademicSession + "', '" + dates.smallestStartDate + "', '" + dates.largestEndDate + "', '" + req.body.classID + "', '" + req.body.faculty + "', '" + data.examTitle + "', '" + JSON.stringify(subExamsJSON) + "', " + dates.totalTotalMarks + ", " + dates.totalPassingMarks + ", " + req.user.EmpID + ")", function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/getExams', function (req, res) {
    var query = "SELECT `Exams`.*, `Name` FROM `Exams` JOIN `UserBioData` ON `CreatedBy` = `StaffID` WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `Exams`.`InstituteCode` = " + req.user.InstituteCode + " AND DATE(`From`) >= '" + req.body.examStartDate + "' AND DATE(`Till`) <= '" + req.body.examEndDate + "' AND `AcademicSession` = '" + req.body.AcademicSession + "';";
    if(req.user.Designation == 'Teacher'){
        query = "SELECT `Exams`.*, `Name` FROM `Exams` JOIN `UserBioData` ON `CreatedBy` = `StaffID` WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `Exams`.`InstituteCode` = " + req.user.InstituteCode + " AND DATE(`From`) >= '" + req.body.examStartDate + "' AND DATE(`Till`) <= '" + req.body.examEndDate + "' AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `CreatedBy` = " + req.user.EmpID;
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

router.post('/getExamsToAttempt', function (req, res) {
    con.query("SELECT * FROM `Exams` WHERE DATE(`From`) = '" + req.body.dated + "' AND `InstituteCode` = " + req.user.InstituteCode + " AND `ExamClass` = '" + req.user.PresentClass + "';" , function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getExamQuestions', function (req, res) {
    con.query("SELECT * FROM `ExamQuestions` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `ExamID` = '" + req.body.examID + "';" , function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getSessionExams', function (req, res) {
    var query = "SELECT * FROM `Exams` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `ExamClass` = '" + req.body.classID + "';";
    if(req.user.Designation == 'Teacher'){
        query = "SELECT * FROM `Exams` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `ExamClass` = '" + req.body.classID + "' AND CreatedBy = " + req.user.EmpID;
    }
    con.query(query , function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getSessionExamsForProgressHistory', function (req, res) {
    var query = "SELECT * FROM `Exams` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `From` < '" + req.body.today + "';";
    if(req.user.Designation == 'Teacher'){
        query = "SELECT * FROM `Exams` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `From` < '" + req.body.today + "' CreatedBy = " + req.user.EmpID;
    }
    con.query(query , function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getProgressHistoryByGR', function (req, res) {
    var query = "SELECT * FROM `ExamMarks` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.AcademicSession + "' AND `StudentGR` = " + req.body.studentGRNumber;
    con.query(query , function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/getExamDetailsByExamID', function (req, res) {
    con.query("SELECT * FROM `Exams` WHERE `ExamID` = " + req.body.ExamID, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

router.post('/modifyExam', function (req, res) {
    con.query("UPDATE `Exams` SET `ExamTitle` = '" + req.body.modifyExamTitle + "', `From` = '" + req.body.modifyExamStartDate + "', `Till` = '" + req.body.modifyExamEndDate + "', `ExamClass` = '" + req.body.modifyClassForExam + "', `TotalMarks` = " + req.body.modifyTotalMarks + ", `PassingMarks` = " + req.body.modifyPassingMarks + " WHERE `ExamID` = " + req.body.modifyExamID, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success')
        }
    });
})

router.post('/uploadQuestion', function (req, res) {
    con.query("INSERT INTO `ExamQuestions` (`ExamID`, `InstituteCode`, `Question`, `Options`, `Answer`, `Marks`) VALUES ('" + req.body.examID + "', " + req.user.InstituteCode + ", '" + req.body.question + "', '" + req.body.options + "', '" + req.body.correctAnswer + "', '" + req.body.marks + "')", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success');
        }
    });
})

router.post('/modifyQuestion', function (req, res) {
    con.query("UPDATE `ExamQuestions` SET `Question` = '" + req.body.question + "', `Options` = '" + req.body.options + "', `Answer` = '" + req.body.correctAnswer + "', `Marks` = '" + req.body.marks + "' WHERE `ID` = '" + req.body.questionID + "' AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            console.log(err.sqlMessage)
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success');
        }
    });
})

router.post('/deleteQuestion', function (req, res) {
    con.query("DELETE FROM `ExamQuestions` WHERE `ID` = '" + req.body.questionID + "' AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else{
            res.json('Success');
        }
    });
})

router.post('/uploadMarks', function (req, res) {
    var counter = 1;
    var errorOccurred = false;
    req.body.data.forEach(element => {
        if (!errorOccurred) {
            con.query("DELETE FROM `ExamMarks` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `ExamID` = " + req.body.examID + " AND `SubjectID` = " + req.body.subjectID + " AND `StudentGR` = " + Object.keys(element)[0].replace('for-GR-', '') + ";INSERT INTO `ExamMarks` (`InstituteCode`, `ExamID`, `SubjectID`, `StudentGR`, `ObtainedMarks`) VALUES (" + req.user.InstituteCode + ", " + req.body.examID + ", " + req.body.subjectID + ", " + Object.keys(element)[0].replace('for-GR-', '') + ", '" + (element[Object.keys(element)[0]] ? element[Object.keys(element)[0]] : "Absent") + "')", function (err, result) {
                if (err) {
                    res.json(err.sqlMessage);
                    errorOccurred = true;
                }
    
                if (counter == req.body.data.length && !errorOccurred) {
                    res.json('Success');
                }
                counter++;
            });
        }
    });
})

router.post('/getUploadedMarks', function (req, res) {
    con.query("SELECT * FROM `ExamMarks` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `ExamID` = " + req.body.examID + " AND `SubjectID` = " + req.body.subjectID, function (err, result) {
        if (err){
            res.json(err.sqlMessage);
        }
        else{
            res.json(result)
        }
    });
})

// router.post('/getUploadedMarksOfStudentBySession', function (req, res) {
//     con.query("SELECT * FROM `ExamMarks` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `StudentGR` = " + req.body.StudentGR + " AND `AcademicSession` = '" + req.body.academicSession + "'", function (err, result) {
//         if (err){
//             res.json(err.sqlMessage);
//         }
//         else{
//             res.json(result)
//         }
//     });
// })

module.exports = router;