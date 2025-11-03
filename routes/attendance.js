const express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    moment = require('moment'),
    router = express.Router(),
    checkAccess = require('../accessControl'),
    { con, attendanceDB } = require('../database'),
    { DateTime } = require('luxon'),
    PAKISTAN_TIMEZONE = 'Asia/Karachi';
;

// Calculate late minutes
function calculateLate(checkIn, shiftStartTime) {
    if (!shiftStartTime) {
        console.warn('Missing shiftStartTime for check-in:', checkIn);
        return 0; // or -1 if you want to flag it
    }

    const date = moment(checkIn).format('YYYY-MM-DD');
    const shiftStartStr = `${date}T${shiftStartTime}`;
    const shiftStart = moment(shiftStartStr); // now in ISO 8601 format

    if (!shiftStart.isValid()) {
        console.warn('Invalid shiftStart:', shiftStartStr);
        return 0;
    }

    const diff = moment(checkIn).diff(shiftStart, 'minutes');
    return diff > 0 ? diff : 0;
}

// Calculate working duration
function calculateWorkMinutes(checkIn, checkOut) {
    let inTime = moment(checkIn);
    let outTime = moment(checkOut);
    if (outTime.isBefore(inTime)) outTime.add(1, 'day');
    return outTime.diff(inTime, 'minutes');
}

function smartSessions(logs, shiftStartTime, shiftDate, maxHoursGap = 18) {
    const sessions = [];
    const usedIndexes = new Set();

    const shiftStartMoment = moment(`${shiftDate}T${shiftStartTime}`);

    let bestCheckInIndex = -1;
    let minDiff = Infinity;

    for (let i = 0; i < logs.length; i++) {
        const logTime = moment(logs[i].punch_time);
        const diff = Math.abs(logTime.diff(shiftStartMoment, 'minutes'));

        if (diff < minDiff && diff <= 120) { // within 2 hours window
            bestCheckInIndex = i;
            minDiff = diff;
        }
    }

    if (bestCheckInIndex !== -1) {
        const checkIn = logs[bestCheckInIndex].punch_time;
        usedIndexes.add(bestCheckInIndex);

        let checkOut = null;
        for (let j = bestCheckInIndex + 1; j < logs.length; j++) {
            const diffHours = moment(logs[j].punch_time).diff(moment(checkIn), 'hours', true);
            if (diffHours > 0 && diffHours <= maxHoursGap) {
                checkOut = logs[j].punch_time;
                usedIndexes.add(j);
                break;
            }
        }

        sessions.push({
            checkIn,
            checkOut
        });
    }

    return sessions;
}

// Get assigned shift for user on a specific date
async function getShiftForUserOnDate(userId, date) {
    const query = `SELECT s.* FROM UserShiftAssignments usa JOIN Shifts s ON usa.ShiftID = s.ID WHERE usa.UserID = ? AND usa.StartDate <= ? AND (usa.EndDate IS NULL OR usa.EndDate >= ?) LIMIT 1`;
    const [rows] = await con.execute(query, [userId, date, date]);
    return rows[0];
}

// Get shift duration valid for a date
async function getShiftDurationOnDate(shiftId, date) {
    const query = `SELECT * FROM ShiftDurations WHERE ShiftID = ? AND StartDate <= ? AND (EndDate IS NULL OR EndDate >= ?) LIMIT 1`;
    const [rows] = await con.execute(query, [shiftId, date, date]);
    return rows[0];
}

// Main route
router.get('/all-staff-attendance', async (req, res) => {
    const { userID, startDate, endDate, dated } = req.query;
    let baseQuery = `
        SELECT 
            iclock_transaction.emp_code, 
            iclock_transaction.punch_time
        FROM iclock_transaction
        WHERE iclock_transaction.punch_state = '0'
    `;
    const params = [];

    /*if (dated) {
        // baseQuery += ` AND DATE(iclock_transaction.punch_time) = ?`;
        baseQuery += ` AND DATE(iclock_transaction.punch_time) BETWEEN ? AND ?`;
        const nextDay = new Date(new Date(dated).getTime() + 24 * 60 * 60 * 1000);
        params.push(dated, nextDay);
    } */

    if (dated) {
        baseQuery += ` AND DATE(iclock_transaction.punch_time) = ?`;
        params.push(dated);
    } else if (startDate && endDate) {
        baseQuery += ` AND DATE(iclock_transaction.punch_time) BETWEEN ? AND ?`;
        params.push(startDate, endDate);
    } else {
        return res.status(400).json({ error: "Provide either 'dated' or both 'startDate' and 'endDate'." });
    }

    if (userID) {
        baseQuery += ` AND iclock_transaction.emp_code = ?`;
        params.push(userID);
    }

    baseQuery += ` ORDER BY iclock_transaction.punch_time ASC`;

    try {
        const [attendanceLogs] = await attendanceDB.execute(baseQuery, params);

        const empCodes = [...new Set(attendanceLogs.map(log => log.emp_code))];
        // const placeholders = empCodes.map(() => '?').join(',');
        // const [userDetails] = await con.execute(`SELECT ID, Name, Email, Designation, ProfilePicture FROM UserDetails WHERE ID IN (${placeholders})`, empCodes);
        let userDetails = [];
        if (empCodes.length > 0) {
            const placeholders = empCodes.map(() => '?').join(',');
            const [rows] = await con.execute(
                `SELECT UserDetails.ID, Name, Email, DesignationTitle, ProfilePicture FROM UserDetails LEFT JOIN Designations ON UserDetails.DesignationID = Designations.ID WHERE UserDetails.ID IN (${placeholders})`,
                empCodes
            );
            userDetails = rows;
        }

        const userMap = {};
        userDetails.forEach(user => {
            userMap[user.ID] = user;
        });

        const enrichedLogs = attendanceLogs.map(log => {
            const user = userMap[log.emp_code] || {};
            return {
                emp_code: log.emp_code,
                punch_time: log.punch_time,
                Name: user.Name || '',
                Email: user.Email || '',
                Designation: user.DesignationTitle || '',
                ProfilePicture: user.ProfilePicture || ''
            };
        });

        const logsByUser = {};
        enrichedLogs.forEach(log => {
            if (!logsByUser[log.emp_code]) logsByUser[log.emp_code] = [];
            logsByUser[log.emp_code].push(log);
        });

        const finalResults = [];

        for (const userId in logsByUser) {
            const logs = logsByUser[userId];
            const sortedLogs = logsByUser[userId].sort((a, b) =>
                new Date(a.punch_time) - new Date(b.punch_time)
            );
            // const sessions = groupSessions(sortedLogs);
            const sessionDate = moment(sortedLogs[0].punch_time).format('YYYY-MM-DD');
            const shift = await getShiftForUserOnDate(userId, sessionDate);
            if (!shift) continue;
            const shiftDuration = await getShiftDurationOnDate(shift.ID, sessionDate);
            if (!shiftDuration) continue;
            const sessions = smartSessions(sortedLogs, shiftDuration.StartTime, sessionDate);

            for (const session of sessions) {
                const sessionDate = moment(session.checkIn).format('YYYY-MM-DD');

                const shift = await getShiftForUserOnDate(userId, sessionDate);
                if (!shift) continue;

                const shiftDuration = await getShiftDurationOnDate(shift.ID, sessionDate);
                if (!shiftDuration) continue;

                const lateMinutes = calculateLate(session.checkIn, shiftDuration.StartTime);
                // const workingMinutes = session.checkOut
                //     ? calculateWorkMinutes(session.checkIn, session.checkOut)
                //     : 0;

                const isToday = moment(session.checkIn).isSame(moment(), 'day');
                let status = 'Completed';
                let workingMinutes = 0;
                if (session.checkOut) {
                    workingMinutes = calculateWorkMinutes(session.checkIn, session.checkOut);
                } else {
                    status = isToday ? 'Still inside premises.' : 'No checkout found in database.';
                }

                const checkInLocal = DateTime.fromJSDate(session.checkIn).setZone('Asia/Karachi', { keepLocalTime: true });
                const checkOutLocal = session.checkOut ? DateTime.fromJSDate(session.checkOut).setZone('Asia/Karachi', { keepLocalTime: true }) : null;

                // const checkInLocal = DateTime.fromJSDate(new Date(session.checkIn), { zone: 'utc' }).setZone(PAKISTAN_TIMEZONE);
                // const checkOutLocal = session.checkOut
                //     ? DateTime.fromJSDate(new Date(session.checkOut), { zone: 'utc' }).setZone(PAKISTAN_TIMEZONE)
                //     : null;

                finalResults.push({
                    UserID: parseInt(userId),
                    Name: logs[0].Name,
                    Email: logs[0].Email,
                    Designation: logs[0].Designation,
                    ProfilePicture: logs[0].ProfilePicture,
                    // CheckIn: session.checkIn,
                    // CheckOut: session.checkOut,
                    CheckIn: checkInLocal,
                    CheckOut: checkOutLocal ? checkOutLocal : null,
                    ShiftName: shift.name,
                    ShiftStartTime: shiftDuration.startTime,
                    ShiftEndTime: shiftDuration.endTime,
                    lateMinutes: calculateLate(session.checkIn, shiftDuration.StartTime),
                    workingMinutes,
                    Status: status
                });

                // finalResults.push({
                //     UserID: parseInt(userId),
                //     Name: logs[0].Name,
                //     Email: logs[0].Email,
                //     Designation: logs[0].Designation,
                //     ProfilePicture: logs[0].ProfilePicture,
                //     CheckIn: session.checkIn,
                //     CheckOut: session.checkOut,
                //     ShiftName: shift.name,
                //     ShiftStartTime: shiftDuration.startTime,
                //     ShiftEndTime: shiftDuration.endTime,
                //     lateMinutes,
                //     workingMinutes
                // });
            }
        }
        // console.log(logs[0])
        res.json(finalResults);
    } catch (error) {
        console.error(error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});


router.get('/staff-attendance', async function (req, res) {
    const { userID, startDate, endDate, dated } = req.query;

    // let baseQuery = `
    //     SELECT 
    //         iclock_transaction.emp_code, 
    //         iclock_transaction.punch_time, 
    //         personnel_employee.first_name, 
    //         personnel_employee.last_name, 
    //         personnel_employee.department_id, 
    //         personnel_position.position_name 
    //     FROM iclock_transaction
    //     JOIN personnel_employee 
    //         ON iclock_transaction.emp_code = personnel_employee.emp_code
    //     LEFT JOIN personnel_position 
    //         ON personnel_employee.position_id = personnel_position.position_code
    //     WHERE iclock_transaction.punch_state = '0'
    // `;
    let baseQuery = `
        SELECT 
            iclock_transaction.emp_code AS EmpID,
            iclock_transaction.punch_time, 
        FROM iclock_transaction
        JOIN personnel_employee 
            ON iclock_transaction.emp_code = personnel_employee.emp_code
        LEFT JOIN personnel_position 
            ON personnel_employee.position_id = personnel_position.position_code
        LEFT JOIN UserDetails ud
            ON iclock_transaction.emp_code = ud.EmpID
        WHERE iclock_transaction.punch_state = '0'
    `;

    const params = [];

    // Date filter (either single date or date range)
    if (dated) {
        baseQuery += ` AND DATE(iclock_transaction.punch_time) = ?`;
        params.push(dated);
    } else if (startDate && endDate) {
        baseQuery += ` AND DATE(iclock_transaction.punch_time) BETWEEN ? AND ?`;
        params.push(startDate, endDate);
    } else {
        return res.status(400).json({ error: "Provide either 'dated' or both 'startDate' and 'endDate'." });
    }

    // User filter
    if (userID) {
        baseQuery += ` AND iclock_transaction.emp_code = ?`;
        params.push(userID);
    }

    baseQuery += ` ORDER BY iclock_transaction.punch_time DESC`;

    try {
        const [result] = await attendanceDB.execute(baseQuery, params);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});


router.get('/staffs-attendance', function (req, res) {
    res.sendFile(path.join(__dirname, '../views/administrator/staffAttendance.html'))
})

router.post('/getStudentAttendanceReport', function (req, res) {
    if (req.body.generateFor == 'students' && req.body.students != '') {
        var query = "SELECT * FROM `ExpenseRecord` JOIN `UserBioData` ON `UserBioData`.`StaffID` = `ExpenseRecord`.`UploadedBy` WHERE `Date` >= '" + req.body.dateFrom + "' AND `DATE` <= '" + req.body.dateTill + "' AND `ExpenseRecord`.`InstituteCode` = '" + req.user.InstituteCode + "'";
        con.query(query, function (err, result) {
            if (err) {
                res.json(err.sqlMessage);
            }
            else {
                res.json(result)
            }
        });
    }
    else if (req.body.generateFor == 'classes' && req.body.classes != '') {
        var query = "SELECT * FROM `ExpenseRecord` JOIN `UserBioData` ON `UserBioData`.`StaffID` = `ExpenseRecord`.`UploadedBy` WHERE `Date` >= '" + req.body.dateFrom + "' AND `DATE` <= '" + req.body.dateTill + "' AND `ExpenseRecord`.`InstituteCode` = '" + req.user.InstituteCode + "'";
        con.query(query, function (err, result) {
            if (err) {
                res.json(err.sqlMessage);
            }
            else {
                res.json(result)
            }
        });
    }
    else {
        res.json('Please select all parameters to generate report.')
    }
})

module.exports = router;