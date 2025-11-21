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

async function smartSessionsForSingleID(logs, userId) {
    if (!logs || logs.length === 0) return [];

    // Group logs by date
    const logsByDate = {};
    logs.forEach(log => {
        const logDate = moment(log.punch_time).format('YYYY-MM-DD');
        if (!logsByDate[logDate]) logsByDate[logDate] = [];
        logsByDate[logDate].push(log);
    });

    const allSessions = [];

    for (const date in logsByDate) {
        const dayLogs = logsByDate[date].sort((a, b) =>
            new Date(a.punch_time) - new Date(b.punch_time)
        );

        // Get shift & duration for this date
        const shift = await getShiftForUserOnDate(userId, date);
        if (!shift) continue;

        const shiftDuration = await getShiftDurationOnDate(shift.ID, date);
        if (!shiftDuration) continue;

        // Call your existing smartSessions
        const sessions = smartSessions(dayLogs, shiftDuration.StartTime, date);
        allSessions.push(...sessions.map(s => ({ ...s, date })));
    }

    return allSessions;
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
            const sessionDate = moment(sortedLogs[0].punch_time).format('YYYY-MM-DD');
            const shift = await getShiftForUserOnDate(userId, sessionDate);
            if (!shift) continue;
            const shiftDuration = await getShiftDurationOnDate(shift.ID, sessionDate);
            if (!shiftDuration) continue;
            // const sessions = smartSessions(sortedLogs, shiftDuration.StartTime, sessionDate);
            let sessions = [];
            if (startDate && endDate && userID) {
                const singleUserLogs = attendanceLogs.filter(l => l.emp_code == userID);
                sessions = await smartSessionsForSingleID(singleUserLogs, userID);
            } else {
                sessions = smartSessions(sortedLogs, shiftDuration.StartTime, sessionDate);
            }

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

                const checkInLocal = DateTime.fromISO(session.checkIn).setZone(PAKISTAN_TIMEZONE)
                const checkOutLocal = session.checkOut ? DateTime.fromJSDate(session.checkOut).setZone('Asia/Karachi', { keepLocalTime: true }) : null;
                finalResults.push({
                    UserID: parseInt(userId),
                    Name: logs[0].Name,
                    Email: logs[0].Email,
                    Designation: logs[0].Designation,
                    ProfilePicture: logs[0].ProfilePicture,
                    CheckIn: checkInLocal,
                    CheckOut: checkOutLocal ? checkOutLocal : null,
                    ShiftName: shift.name,
                    ShiftStartTime: shiftDuration.startTime,
                    ShiftEndTime: shiftDuration.endTime,
                    lateMinutes: calculateLate(session.checkIn, shiftDuration.StartTime),
                    workingMinutes,
                    Status: status
                });
            }
        }
        res.json(finalResults);
    } catch (error) {
        console.error(error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

module.exports = router;