var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    nodemailer = require('nodemailer'),
    smtpTransport = require('nodemailer-smtp-transport'),
    queryString = require('querystring'),
    router = express.Router(),
    checkAccess = require('../accessControl'),
    { google } = require('googleapis')
    ;

const { con } = require('../database');
router.use(bodyParser.urlencoded({ extended: true }));
router.post('/update-employee-status', async function (req, res) {
    const { empID, status } = req.body;
    const sql = "UPDATE UserDetails SET Status=? WHERE ID=?";
    const [result] = await con.execute(sql, [status, empID]);
    if (result.affectedRows > 0) {
        res.json('Success');
    } else {
        res.status(404).json('Employee not found');
    }
})

router.post('/update-employee-department', async function (req, res) {
    const { empID, department } = req.body;
    const sql = "UPDATE UserDetails SET DepartmentID = ? WHERE ID = ?";
    const [result] = await con.execute(sql, [department, empID]);
    if (result.affectedRows > 0) {
        res.json('Success');
    } else {
        res.status(404).json('Employee not found');
    }
})

router.get('/get-designations', async function (req, res) {
    try {
        const [result] = await con.execute("SELECT * FROM `Designations` WHERE `Department` != 5");
        res.json(result);
    } catch (err) {
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.delete('/delete-profile', async function (req, res) {
    try {
        const [result] = await con.execute("DELETE FROM `UserDetails` WHERE `ID` = ?", [req.query.empID]);
        if (result.affectedRows > 0) {
            res.json('Success');
        } else {
            res.status(404).json('Profile not found');
        }
    } catch (err) {
        console.error("Error deleting profile:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.post('/upload-shift-record', async (req, res) => {
    try {
        const { empID, workingShift, startDate } = req.body;

        if (!empID || !workingShift || !startDate) {
            return res.status(400).json("All fields are required.");
        }

        // Check for existing active shift (with EndDate IS NULL)
        const [existing] = await con.execute(
            'SELECT * FROM UserShiftAssignments WHERE UserID = ? AND EndDate IS NULL LIMIT 1',
            [empID]
        );

        if (existing.length > 0) {
            const current = existing[0];

            // Case 1: same StartDate exists → just update ShiftID
            if (current.StartDate.toISOString().split('T')[0] === startDate) {
                await con.execute(
                    'UPDATE UserShiftAssignments SET ShiftID = ? WHERE ID = ?',
                    [workingShift, current.ID]
                );
            } else {
                // Case 2: StartDate is different → end old record and insert new one
                await con.execute(
                    'UPDATE UserShiftAssignments SET EndDate = ? WHERE ID = ?',
                    [startDate, current.ID]
                );

                await con.execute(
                    'INSERT INTO UserShiftAssignments (UserID, ShiftID, StartDate) VALUES (?, ?, ?)',
                    [empID, workingShift, startDate]
                );
            }

        } else {
            // Case 3: No current active shift → insert new record
            await con.execute(
                'INSERT INTO UserShiftAssignments (UserID, ShiftID, StartDate) VALUES (?, ?, ?)',
                [empID, workingShift, startDate]
            );
        }

        res.json('Successfully uploaded shift record.');
    } catch (error) {
        console.error(error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});


const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../experts-crm-9d6ac1b67e39.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

router.get('/get-salary-data-from-google-sheet', async (req, res) => {
    try {
        const { sheetName } = req.query;
        if (!sheetName) return;

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const spreadsheetId = '1ALGlsDH3hLffZhDanTsVaDDGLZxnxZuHuUfl1dURZO4';
        const range = sheetName;

        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        res.json(response.data.values);
    } catch (err) {
        // console.error('Google Sheets API Error:', err);
        res.status(500).json({ message: 'Failed to fetch data from Google Sheets.' });
    }
});

router.get('/get-salary-data-from-google-sheet-by-id/:empID', async (req, res) => {
    const empIDToFind = req.params.empID;

    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const spreadsheetId = '1ALGlsDH3hLffZhDanTsVaDDGLZxnxZuHuUfl1dURZO4';

        // 1. Get allowed sheets from DB
        const [allowedRows] = await con.query(`SELECT SheetName FROM AllowedSheets WHERE IsPublic = 1`);
        const allowedSheets = allowedRows.map(r => r.SheetName);

        // 2. Get all sheet names from Google Sheets
        const metadata = await sheets.spreadsheets.get({ spreadsheetId });
        const allSheets = metadata.data.sheets.map(s => s.properties.title);

        // 3. Filter by allowed list
        const filteredSheets = allSheets.filter(name => allowedSheets.includes(name));

        // 4. Search in allowed sheets
        let matchedRows = [];

        for (const sheetName of filteredSheets) {
            const result = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: sheetName,
            });

            const rows = result.data.values;
            if (!rows || rows.length === 0) continue;

            const headers = rows[0];
            const empIdIndex = headers.indexOf('EmpID');
            if (empIdIndex === -1) continue;

            const matches = rows.slice(1).filter(row => row[empIdIndex] === empIDToFind);

            matches.forEach(row => {
                matchedRows.push({
                    sheet: sheetName,
                    data: Object.fromEntries(headers.map((h, i) => [h, row[i] || '']))
                });
            });
        }

        res.status(200).json({ matchedRows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to search EmpID in allowed sheets.' });
    }
});

router.post('/make-sheet-public', async (req, res) => {
    try {
        const { sheetName, selectedMonth } = req.body;
        const [result] = await con.execute("INSERT INTO `PublishedPayReceiptsSheet`(`ForMonth`, `SheetName`) VALUES (?, ?)", [sheetName, selectedMonth]);
        res.json('Success');
    } catch (err) {
        console.error("Error makeing sheet public: ", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
})


router.get('/getTeachersList', function (req, res) {
    con.query("SELECT * FROM `UserBioData` JOIN `UserLoginDetails` ON `UserBioData`.StaffID = `UserLoginDetails`.EmpID WHERE `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `UserLoginDetails`.`InstituteCode` = " + req.user.InstituteCode + " AND `EmploymentStatus` = 'Active'", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json(result)
        }
    });
})

router.post('/getTeachersSubjects', function (req, res) {
    con.query("SELECT * FROM `AssignedSubjectsToTeachers` WHERE `InstituteCode` = " + req.user.InstituteCode + " AND `TeacherID` = " + req.body.TeacherID, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json(result)
        }
    });
})

router.post('/addNewSubject', function (req, res) {
    var params = new URLSearchParams(req.body.subjectTitle);
    var subjectTitles = params.getAll('subjectTitle');
    var a = 1, isError = false, errorMessage = '';
    subjectTitles.forEach(element => {
        con.query("INSERT INTO `Subjects` (`InstituteCode`, `AcademicSession`, `SubjectName`) VALUES (" + req.user.InstituteCode + ", '" + req.body.academicSession + "', '" + element + "')", function (err, result) {
            if (err) {
                isError = true;
                errorMessage = err.sqlMessage;
            }

            if (a == subjectTitles.length && isError) {
                res.json(errorMessage)
            }
            else if (a == subjectTitles.length && !isError) {
                res.json('Success')
            }
            a++;
        });
    });
})

router.post('/assignToClass', function (req, res) {
    var params = new URLSearchParams(req.body.details);
    con.query("UPDATE Subjects SET `Classes` = '" + params.getAll('classes').join(',') + "' WHERE ID = " + params.getAll('subjectToAssign') + " AND `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.academicSession + "'", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
})

router.post('/getAssignedTeachers', function (req, res) {
    con.query("SELECT `AssignedSubjectsToTeachers`.*, `UserBioData`.`Name` FROM `AssignedSubjectsToTeachers` JOIN `UserBioData` ON `TeacherID` = `StaffID` WHERE `AssignedSubjectsToTeachers`.`InstituteCode` = " + req.user.InstituteCode + " AND `UserBioData`.`InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.academicSession + "'", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json(result)
        }
    });
})

router.post('/assignCourseToTeachers', function (req, res) {
    var data = queryString.parse(req.body.details);
    var JSONstring = [];
    req.body.subjects.forEach(element => {
        var item = {
            Classes: Array.isArray(data['newSubjectClasses-' + element]) ? data['newSubjectClasses-' + element].join(',') : data['newSubjectClasses-' + element],
            SubjectID: data['newSubject-' + element]
        };
        JSONstring.push(item);
    });
    con.query("DELETE FROM `AssignedSubjectsToTeachers` WHERE `TeacherID` = " + data.teacher + " AND `InstituteCode` = " + req.user.InstituteCode + " AND `AcademicSession` = '" + req.body.academicSession + "'; INSERT INTO `AssignedSubjectsToTeachers`(`InstituteCode`, `TeacherID`, `AssignedSubject`, `AcademicSession`) VALUES (" + req.user.InstituteCode + ", " + data.teacher + ", '" + JSON.stringify(JSONstring) + "', '" + req.body.academicSession + "');", function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            res.json('Success')
        }
    });
})

router.post('/sendOTP', function (req, res) {
    con.query("SELECT * FROM `InstituteDetails` WHERE `InstituteCode` = " + req.user.InstituteCode, function (err, result) {
        if (err) {
            res.json(err.sqlMessage);
        }
        else {
            sendEmail(result[0].RegisteredEmail, 'Your one time password for access management is ' + req.body.otp + '.<br><div style="color: red;">Do not share this OTP with anyone.</div>', res)
        }
    });
})

function sendEmail(sendTo, message, res) {
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
            subject: 'OTP for access management.',
            html: message,
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                res.json('Error sending email. ', error);
            }
            else {
                res.json('Success');
            }
        });
    })();
}

module.exports = router;