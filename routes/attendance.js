const express = require('express');
const router = express.Router();
const { con, attendanceDB } = require('../database');
const moment = require('moment');

// -------------------- Helper Functions --------------------

// Centralized logic to calculate all metrics for a specific day
function calculateDailyMetrics(checkIn, checkOut, shiftStartStr, shiftEndStr, requiredHours, dayDate) {
    // Defaults
    let lateMinutes = 0;
    let leftEarlyMinutes = 0;
    let extraMinutes = 0;
    let workingMinutes = 0;
    let status = 'Absent';

    // 1. Status Determination
    if (checkIn) {
        status = 'Present';
        if (!checkOut) status = 'Left without checkout';
    }

    // If no shift is assigned, we can't calculate specific lateness/early leaving relative to shift
    if (!shiftStartStr || !shiftEndStr) {
        // Basic working minutes if no shift defined
        if (checkIn && checkOut) {
            workingMinutes = moment(checkOut).diff(moment(checkIn), 'minutes');
        }
        return { lateMinutes, leftEarlyMinutes, extraMinutes, workingMinutes, status };
    }

    // 2. Parse Shift Timings
    const shiftStartMoment = moment(`${dayDate}T${shiftStartStr}`);
    let shiftEndMoment = moment(`${dayDate}T${shiftEndStr}`);

    // Handle overnight shifts (e.g., Start 22:00, End 06:00)
    if (shiftEndMoment.isBefore(shiftStartMoment)) {
        shiftEndMoment.add(1, 'day');
    }

    // 3. Parse Punch Timings
    const inMoment = checkIn ? moment(checkIn) : null;
    const outMoment = checkOut ? moment(checkOut) : null;

    // 4. Calculate Working Minutes
    if (inMoment && outMoment) {
        // Handle overnight work (if out is before in)
        let calcOut = outMoment.clone();
        if (calcOut.isBefore(inMoment)) calcOut.add(1, 'day');
        workingMinutes = calcOut.diff(inMoment, 'minutes');
    }

    // 5. Calculate Late Minutes (CheckIn > ShiftStart)
    if (inMoment && inMoment.isAfter(shiftStartMoment)) {
        if (!requiredHours) {
            lateMinutes = inMoment.diff(shiftStartMoment, 'minutes');
        }
    }

    // 6. Calculate Left Early Minutes (CheckOut < ShiftEnd)
    // Only calculate if they actually checked out
    if (outMoment && outMoment.isBefore(shiftEndMoment)) {
        const earlyMinutes = shiftEndMoment.diff(outMoment, 'minutes');
        leftEarlyMinutes = earlyMinutes - (requiredHours * 60)
    }

    // 7. Calculate Extra Hours (CheckOut > ShiftEnd)
    // Requirement: Only calculate time AFTER shift end. Do not include early check-in.
    // if (outMoment && outMoment.isAfter(shiftEndMoment)) {
    //     extraMinutes = outMoment.diff(shiftEndMoment, 'minutes');
    // }

    const shiftHours = moment(shiftEndStr).diff(moment(shiftEndStr), 'minutes');
    if (workingMinutes > shiftHours) {
        extraMinutes = outMoment.diff(shiftEndMoment, 'minutes');
    }

    return { lateMinutes, leftEarlyMinutes, extraMinutes, workingMinutes, status };
}

// Fetch shift info for a user
async function getUserShift(userID, day) {
    const [rows] = await con.execute(`
        SELECT sd.StartTime, sd.EndTime
        FROM UserShiftAssignments usa
        JOIN ShiftDurations sd ON usa.ShiftID = sd.ShiftID
        WHERE usa.UserID = ?
          AND ? BETWEEN usa.StartDate AND IFNULL(usa.EndDate,'9999-12-31')
          AND ? BETWEEN sd.StartDate AND IFNULL(sd.EndDate,'9999-12-31')
        LIMIT 1
    `, [userID, day, day]);
    return rows[0] || null;
}

// Fetch required hours for hourly employees
async function getHourlyRequiredHours(userID) {
    const [rows] = await con.execute(`SELECT RequiredHours FROM HourlyEmployees WHERE EmployeeID=?`, [userID]);
    return rows[0]?.RequiredHours || null;
}

// Fetch check-in and check-out within windows
async function getCheckInOut(userID, shiftStart, day) {
    const shiftStartMoment = moment(`${day}T${shiftStart}`);
    const checkInStart = shiftStartMoment.clone().subtract(3, 'hours');
    const checkInEnd = shiftStartMoment.clone().add(5, 'hours');
    const checkOutEnd = shiftStartMoment.clone().add(15, 'hours');

    const [logs] = await attendanceDB.execute(`
        SELECT emp_code AS UserID, punch_time AS PunchTime
        FROM iclock_transaction
        WHERE punch_state=0 AND emp_code=? 
          AND punch_time BETWEEN ? AND ?
        ORDER BY punch_time ASC
    `, [userID, checkInStart.format('YYYY-MM-DD HH:mm:ss'), checkOutEnd.format('YYYY-MM-DD HH:mm:ss')]);

    // Determine check-in and check-out
    const checkIn = logs.find(l => moment(l.PunchTime).isBetween(checkInStart, checkInEnd, null, '[]'))?.PunchTime || null;
    // const checkOut = logs.reverse().find(l => moment(l.PunchTime).isBetween(checkIn, checkOutEnd, null, '[]'))?.PunchTime || null;
    const checkOut = logs
        .reverse()
        .find(l =>
            moment(l.PunchTime).isAfter(checkIn) &&      // strictly after check-in
            moment(l.PunchTime).isBefore(checkOutEnd)     // within range
        )?.PunchTime || null;

    return { checkIn, checkOut };
}

// -------------------- API: /day --------------------
router.get('/day', async (req, res) => {
    const { day } = req.query;
    if (!day) return res.status(400).json({ error: 'Please provide day parameter' });

    try {
        const [users] = await con.execute(`
            SELECT u.ID AS UserID, u.Name, u.ProfilePicture,
                   d.DepartmentName, des.DesignationTitle
            FROM UserDetails u
            LEFT JOIN Departments d ON u.DepartmentID = d.ID
            LEFT JOIN Designations des ON u.DesignationID = des.ID
            WHERE u.Status='Active' AND d.ID != 5
        `);

        const results = [];
        for (const user of users) {
            const shift = await getUserShift(user.UserID, day);
            const shiftStart = shift?.StartTime;
            const shiftEnd = shift?.EndTime;

            let checkIn = null;
            let checkOut = null;
            if (shiftStart) {
                const io = await getCheckInOut(user.UserID, shiftStart, day);
                checkIn = io.checkIn;
                checkOut = io.checkOut;
            }

            const requiredHours = await getHourlyRequiredHours(user.UserID);

            // Calculate all metrics using the new logic
            const metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

            results.push({
                UserID: user.UserID,
                Name: user.Name,
                ProfilePicture: user.ProfilePicture,
                DepartmentName: user.DepartmentName,
                DesignationTitle: user.DesignationTitle,
                CheckIn: checkIn,
                CheckOut: checkOut,
                Status: metrics.status,
                LateMinutes: metrics.lateMinutes,
                LeftEarlyMinutes: metrics.leftEarlyMinutes, // New Field
                WorkingMinutes: metrics.workingMinutes,
                ExtraHours: metrics.extraMinutes, // Updated Logic
                shiftStart,
                shiftEnd
            });
        }

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------- /user API --------------------
router.get('/user', async (req, res) => {
    const { userID, startDate, endDate } = req.query;
    if (!userID || !startDate || !endDate) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const [users] = await con.execute(`
            SELECT u.ID AS UserID, u.Name, u.ProfilePicture,
                   d.DepartmentName, des.DesignationTitle
            FROM UserDetails u
            LEFT JOIN Departments d ON u.DepartmentID = d.ID
            LEFT JOIN Designations des ON u.DesignationID = des.ID
            WHERE u.ID = ? AND u.Status='Active' AND d.ID != 5
        `, [userID]);

        if (!users.length) return res.status(404).json({ error: 'User not found' });
        const user = users[0];

        const results = [];
        let curDate = moment(startDate);
        const end = moment(endDate);

        while (curDate <= end) {
            const day = curDate.format('YYYY-MM-DD');

            const shift = await getUserShift(user.UserID, day);
            const shiftStart = shift?.StartTime;
            const shiftEnd = shift?.EndTime;

            let checkIn = null;
            let checkOut = null;
            if (shiftStart) {
                const io = await getCheckInOut(user.UserID, shiftStart, day);
                checkIn = io.checkIn;
                checkOut = io.checkOut;
            }

            const requiredHours = await getHourlyRequiredHours(user.UserID);

            // Calculate all metrics using the new logic
            const metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

            results.push({
                UserID: user.UserID,
                Name: user.Name,
                ProfilePicture: user.ProfilePicture,
                DepartmentName: user.DepartmentName,
                DesignationTitle: user.DesignationTitle,
                CheckIn: checkIn,
                CheckOut: checkOut,
                Status: metrics.status,
                LateMinutes: metrics.lateMinutes,
                LeftEarlyMinutes: metrics.leftEarlyMinutes, // New Field
                WorkingMinutes: metrics.workingMinutes,
                ExtraHours: metrics.extraMinutes, // Updated Logic
                Date: day
            });

            curDate.add(1, 'day');
        }

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// -------------------- /range API --------------------
router.get('/range', async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const [users] = await con.execute(`
            SELECT u.ID AS UserID, u.Name, u.ProfilePicture,
                   d.DepartmentName, des.DesignationTitle
            FROM UserDetails u
            LEFT JOIN Departments d ON u.DepartmentID = d.ID
            LEFT JOIN Designations des ON u.DesignationID = des.ID
            WHERE u.Status='Active' AND d.ID != 5
        `);

        const results = [];

        for (const user of users) {
            let curDate = moment(startDate);
            const end = moment(endDate);

            while (curDate <= end) {
                const day = curDate.format('YYYY-MM-DD');

                const shift = await getUserShift(user.UserID, day);
                const shiftStart = shift?.StartTime;
                const shiftEnd = shift?.EndTime;

                let checkIn = null;
                let checkOut = null;
                if (shiftStart) {
                    const io = await getCheckInOut(user.UserID, shiftStart, day);
                    checkIn = io.checkIn;
                    checkOut = io.checkOut;
                }

                const requiredHours = await getHourlyRequiredHours(user.UserID);

                // Calculate all metrics using the new logic
                const metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

                results.push({
                    UserID: user.UserID,
                    Name: user.Name,
                    ProfilePicture: user.ProfilePicture,
                    DepartmentName: user.DepartmentName,
                    DesignationTitle: user.DesignationTitle,
                    CheckIn: checkIn,
                    CheckOut: checkOut,
                    Status: metrics.status,
                    LateMinutes: metrics.lateMinutes,
                    LeftEarlyMinutes: metrics.leftEarlyMinutes, // New Field
                    WorkingMinutes: metrics.workingMinutes,
                    ExtraHours: metrics.extraMinutes, // Updated Logic
                    Date: day
                });

                curDate.add(1, 'day');
            }
        }

        res.json(results);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;