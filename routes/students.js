var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    nodemailer = require('nodemailer'),
    smtpTransport = require('nodemailer-smtp-transport'),
    router = express.Router(),
    checkAccess = require('../accessControl'),
    crypto = require("crypto");
{ con } = require('../database')
    ;

router.use(express.json());
router.use(bodyParser.urlencoded({ extended: true }));

router.get('/present-students', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/browseStudent.html'))
})

router.get('/left-students', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/leftStudent.html'))
})

router.get('/upgrade-profile', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/upgradeProfile.html'))
})

router.get('/enroll-student', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/enrollStudent.html'))
})

router.get('/approve-profiles', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/approveProfiles.html'))
})

router.get('/getAcademicSession', async (req, res) => {
    try {
        const [result] = await con.execute("SELECT `SessionID`, `AcademicSession` FROM `SoftwareConfiguration` WHERE `InstituteID` = ? ORDER BY `SessionID` DESC", [req.user.InstituteID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured. ", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.get('/getClassesList', async (req, res) => {
    try {
        const [result] = await con.execute("SELECT `ClassID`, `ClassTitle` FROM `ClassesList` WHERE `InstituteID` = ? AND `SessionID` = ?", [req.user.InstituteID, req.query.AcademicSessionID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured. ", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.get('/getFaculty', async (req, res) => {
    try {
        const [result] = await con.execute("SELECT `FacultyID`, `FacultyName` FROM `Faculty` WHERE `InstituteID` = ? AND `SessionID` = ? AND FIND_IN_SET(?, `AssignedTo`)", [req.user.InstituteID, req.query.SessionID, req.query.ClassID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured. ", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.get('/getFacultySection', async (req, res) => {
    try {
        const [result] = await con.execute("SELECT `SectionID`, `SectionName`, `TotalSeats` FROM `ClassSection` WHERE `AcademicSessionID` = ? AND `ClassID` = ? AND `FacultyID` = ?", [req.query.AcademicSessionID, req.query.ClassID, req.query.FacultyID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured. ", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.post('/enrollStudent', async (req, res) => {
    let connection;
    try {
        connection = await con.getConnection();
        await connection.beginTransaction(); // Start transaction

        // Insert into StudentsRecord (Auto-increment PortalID)
        const [studentResult] = await connection.execute(
            `INSERT INTO StudentsRecord (InstituteID, GRNumber, StudentsName, FatherName, CityOfBirth, ContactNumber, 
            AlternateContactNumber, ResidentialAddress, Gender, DateOfBirth, Nationality, Religion, MotherTongue, DateOfAdmission, Image)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
                req.user.InstituteID, req.body.GRNumber || 0, req.body.fullName, req.body.fatherName,
                req.body.city, req.body.contactNumber, req.body.alternateContactNumber,
                req.body.residentialAddress, req.body.gender, req.body.dateOfBirth,
                req.body.nationality, req.body.religion, req.body.motherTongue,
                req.body.dateOfAdmission, req.body.imageURL || ''
            ]
        );

        // Get the auto-incremented PortalID
        const portalID = studentResult.insertId;

        // Insert into StudentClassesHistory
        await connection.execute(
            `INSERT INTO StudentClassesHistory 
            (PortalID, InstituteID, PresentClassID, FacultyID , ClassSection, ConcessionAmount, AcademicSession) VALUES (?, ?, ?, ?, ?, ?, ?);`,
            [
                portalID, req.user.InstituteID, req.body.classOfAdmission,
                req.body.facultyOfAdmission, req.body.facultySectionOfAdmission,
                req.body.concessionAmount || 0, req.body.academicSession
            ]
        );

        // Insert into StudentLoginDetails
        const generatePassword = () => crypto.randomInt(100000, 1000000).toString();
        await connection.execute(`INSERT INTO StudentLoginDetails (PortalID, InstituteID, UserPassword) VALUES (?, ?, ?);`, [portalID, req.user.InstituteID, generatePassword()]);

        // Commit transaction
        await connection.commit();
        res.json('Success');

    } catch (error) {
        if (connection) await connection.rollback(); // Rollback if error occurs
        console.log("Transaction failed:", error);
        res.status(500).json(error.message);

    } finally {
        if (connection) connection.release();
    }
});

router.get('/getStudentsData', async (req, res) => {
    const { AcademicSessionID, ClassID, FacultyID, FacultySection } = req.query;
    if (!AcademicSessionID || !ClassID) {
        return res.status(400).json("Academic session and class of admission are required.");
    }

    let query = `
        SELECT 
            sr.PortalID, sr.GRNumber, sr.StudentsName, sr.FatherName, sr.Gender, sr.DateOfBirth, 
            sr.ContactNumber, sr.AlternateContactNumber, sr.ResidentialAddress, sr.Image
        FROM StudentsRecord sr
        JOIN StudentClassesHistory sch ON sr.PortalID = sch.PortalID
        WHERE sch.AcademicSession = ? AND sch.PresentClassID = ?
    `;

    let queryParams = [AcademicSessionID, ClassID];

    if (FacultyID) {
        query += " AND sch.FacultyID = ?";
        queryParams.push(FacultyID);
    }

    if (FacultySection) {
        query += " AND sch.ClassSection = ?";
        queryParams.push(FacultySection);
    }

    try {
        const [result] = await con.execute(query, queryParams);
        res.status(200).json(result);
    } catch (error) {
        console.log("Error fetching students:", error);
        res.status(500).json(error.message);
    }
})

router.post('/getLeftStudentsByClass', function (req, res) {
    var query = "SELECT * FROM `StudentsRecord` JOIN `StudentClassesHistory` ON `GRNumber` = `StudentGR` WHERE `StudentClassesHistory`.`InstituteCode` = " + req.user.InstituteCode + " AND `StudentClassesHistory`.`AcademicSession` = '" + req.body.academicSession + "' AND `PresentClass` = '" + req.body.presentClass + "' AND `DateOfTermination` != '0000-00-00'";
    if (req.body.facultyOfAdmission != '') {
        query += " AND `Faculty` = '" + req.body.facultyOfAdmission + "'";
    }
    if (req.body.sectionOfAdmission != '') {
        query += " AND `ClassSection` = '" + req.body.sectionOfAdmission + "'";
    }
    con.query(query, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json(result)
        }
    });
})

router.post('/updateStudentData', function (req, res) {
    // con.query("UPDATE `StudentsRecord` SET `FormNumber` = " + req.body.formNumber + ", `StudentsName` = '" + req.body.studentName + "', `FatherName` = '" + req.body.fatherName + "', `CityOfBirth` = '" + req.body.cityOfBirth + "', `ContactNumber` = " + req.body.contactNumber + ", `ResidentialAddress` = '" + req.body.residentialAddress + "', `Gender` = '" + req.body.gender + "', `DateOfBirth` = '" + req.body.dateOfBirth + "', `ClassOfAdmission` = " + req.body.classofAdmission + ", `AcademicSession` = '" + req.body.academicSessions + "', `Nationality` = '" + req.body.nationality + "', `Religion` = '" + req.body.religion + "', `MotherTongue` = '" + req.body.motherTongue + "' WHERE `GRNumber` = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode + "; UPDATE `StudentClassesHistory` SET `StudentGR` = " + req.body.grNumber + ", `PresentClass` = " + req.body.classofAdmission + " WHERE `StudentGR` = " + req.body.grNumber + " AND `AcademicSession` = '" + req.body.academicSessions + "' AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
    con.query("UPDATE `StudentsRecord` SET `StudentsName` = '" + req.body.studentName + "', `FatherName` = '" + req.body.fatherName + "', `CityOfBirth` = '" + req.body.cityOfBirth + "', `ContactNumber` = " + req.body.contactNumber + ", `AlternateContactNumber` = " + req.body.alternateContact + ", `ResidentialAddress` = '" + req.body.residentialAddress + "', `Gender` = '" + req.body.gender + "', `DateOfBirth` = '" + req.body.dateOfBirth + "', `Nationality` = '" + req.body.nationality + "', `Religion` = '" + req.body.religion + "', `MotherTongue` = '" + req.body.motherTongue + "', `Image` = '" + req.body.imageName + "' WHERE `GRNumber` = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode + ";UPDATE `StudentClassesHistory` SET `ConcessionAmount` = '" + req.body.concessionAmount + "' WHERE `StudentGR` = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.academicSession + "';UPDATE `StudentLoginDetails` SET `UserEmail` = '" + req.body.email + "' WHERE `GRNumber` = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
})

router.post('/enableStudentProfile', function (req, res) {
    con.query("UPDATE `StudentsRecord` SET `DateOfTermination` = '0000-00-00' WHERE `GRNumber` = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode + "; DELETE FROM `StudentClassesHistory` WHERE StudentGR = " + req.body.grNumber + " AND `InstituteCode` = " + req.user.InstituteCode + " AND AcademicSession = '" + req.body.academicSessionsForEnable + "'; INSERT INTO `StudentClassesHistory`(`StudentGR`, `InstituteCode`, `PresentClass`, `ClassSection`, `AcademicSession`) VALUES (" + req.body.grNumber + ", " + req.user.InstituteCode + ", " + req.body.classofAdmissionForEnable + ", '" + req.body.sectionOfAdmissionForEnable + "', '" + req.body.academicSessionsForEnable + "')", function (err, results) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
})

router.post('/disableStudentProfile', function (req, res) {
    con.query("UPDATE `StudentsRecord` SET `DateOfTermination` = '" + req.body.studentDisableDate + "', `DisableReason` = '" + req.body.disableReason + "' WHERE `GRNumber` = " + req.body.disableStudentID + " AND `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
})

router.get('/getUpcomingGR', function (req, res) {
    con.query("SELECT `GRNumber` FROM `StudentsRecord` WHERE InstituteCode = " + req.user.InstituteCode + " ORDER BY `GRNumber` DESC", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json(result)
        }
    });
})

router.post('/approveProfile', function (req, res) {
    con.query("SELECT MAX(`GRNumber`) AS 'GR' FROM `StudentsRecord` WHERE `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            con.query("INSERT INTO `StudentsRecord`(`InstituteCode`, `GRNumber`, `StudentsName`, `FatherName`, `CityOfBirth`, `ContactNumber`, `AlternateContactNumber`, `ResidentialAddress`, `Gender`, `DateOfBirth`, `Nationality`, `Religion`, `MotherTongue`, `DateOfAdmission`, `Image`) VALUES (" + req.user.InstituteCode + ", " + (result[0].GR + 1) + ", '" + req.body.studentName + "', '" + req.body.fatherName + "', '" + req.body.cityOfBirth + "', '" + req.body.contactNumber + "', '" + req.body.alternateContact + "', '" + req.body.residentialAddress + "', '" + req.body.gender + "', '" + req.body.dateOfBirth + "', '" + req.body.nationality + "', '" + req.body.religion + "', '" + req.body.motherTongue + "', '" + req.body.dateOfAdmission + "', '" + req.body.imageName + "'); INSERT INTO `StudentClassesHistory` (`StudentGR`, `InstituteCode`, `PresentClass`, `Faculty`, `ClassSection`, `ConcessionAmount`, `AcademicSession`) VALUES('" + (result[0].GR + 1) + "', '" + req.user.InstituteCode + "', '" + req.body.classOfAdmission + "', '" + req.body.facultyOfAdmission + "', '" + req.body.sectionOfAdmission + "', '" + req.body.concessionAmount + "', '" + req.body.academicSession + "'); INSERT INTO `StudentLoginDetails` (`InstituteCode`, `GRNumber`, `UserEmail`) VALUES (" + req.user.InstituteCode + ", " + (result[0].GR + 1) + ", '" + req.body.emailAddress + "');UPDATE `Leads` SET `Status` = 'Approved' WHERE `ID` = " + req.body.leadID, function (err, result) {
                if (err) {
                    res.json(err.sqlMessage);
                }
                else {
                    let message = `Hi <b>${req.body.studentName}</b>!<br>Your profile has been created.<br>You can now login to eIMS using the link given below;<br>https://cims1.edinn.com.pk <br>Use <b>login</b> as your temporary password.<br>Do not forget to change this temporay password.`;
                    sendEmail(req.body.emailAddress, message)
                    res.json('Success')
                }
            });
        }
    });
})

router.post('/upgradeProfiles', function (req, res) {
    var a = 1, isError = false, errorMessage = '', query = '';
    req.body.IDs.forEach(element => {
        query += "DELETE FROM `StudentClassesHistory` WHERE `StudentGR` = " + element + " AND `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.upgradeToSession + "';\n";
        query += "INSERT INTO `StudentClassesHistory` (`StudentGR`, `InstituteCode`, `PresentClass`, `Faculty`, `ClassSection`, `AcademicSession`) VALUES (" + element + ", " + req.user.InstituteCode + ", '" + req.body.upgradeToClass + "', '" + req.body.upgradeToFaculty + "', '" + req.body.upgradeToSection + "', '" + req.body.upgradeToSession + "');\n";

        // con.query("SELECT * FROM `StudentClassesHistory` WHERE `StudentGR` = " + element + " AND `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.upgradeToSession + "'", function (err, result) {
        //     if (!err){
        //         var query = "INSERT INTO `StudentClassesHistory` (`StudentGR`, `InstituteCode`, `PresentClass`, `AcademicSession`) VALUES (" + element + ", " + req.user.InstituteCode + ", '" + req.body.upgradeToClass + "', '" + req.body.upgradeToSession + "')";
        //         if(result.length > 0){
        //             var query = "UPDATE `StudentClassesHistory` SET PresentClass = " + req.body.upgradeToClass + " WHERE `StudentGR` = " + element + " AND InstituteCode = " + req.user.InstituteCode + " AND AcademicSession = '" + req.body.upgradeToSession + "'";
        //         }
        //         con.query(query, function (err1, result1) {
        //             if (err1){
        //                 errorMessage = err1.sqlMessage;
        //                 isError = true;
        //             }
        //         });

        //         if(a == req.body.IDs.length && !isError){
        //             res.json('Success')
        //         }
        //         else if(a == req.body.IDs.length && isError){
        //             res.json(errorMessage)
        //         }
        //         a++;
        //     }
        // });
    });

    con.query(query, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
});

function sendEmail(sendTo, message) {
    (async () => {
        const transporter = nodemailer.createTransport(smtpTransport({
            host: 'mail.edinn.com.pk',
            secureConnection: false,
            tls: {
                rejectUnauthorized: false
            },
            port: 587,
            auth: {
                user: 'eims@edinn.com.pk',
                pass: 'nT{XA3,XyqH}4',
            }
        }));

        const mailOptions = {
            from: 'Engineers & Doctors Inn <eims@edinn.com.pk>',
            to: sendTo,
            subject: 'Welcome to eIMS',
            html: message,
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log('Error sending email. ', error);
            }
            else {
                console.log('Email sent successfully. ', info.response);
            }
        });
    })();
}

module.exports = router;