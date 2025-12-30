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
    const shiftStartMoment = moment(`${dayDate} ${shiftStartStr}`, 'YYYY-MM-DD HH:mm:ss', true);
    let shiftEndMoment = moment(`${dayDate} ${shiftEndStr}`, 'YYYY-MM-DD HH:mm:ss', true);

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
            const mnt = inMoment.diff(shiftStartMoment, 'minutes');
            lateMinutes = mnt > 15 ? mnt : 0;
        }
    }

    // 6. Calculate Left Early Minutes (CheckOut < ShiftEnd)
    // Only calculate if they actually checked out
    // if (outMoment && outMoment.isBefore(shiftEndMoment)) {
    //     const earlyMinutes = shiftEndMoment.diff(outMoment, 'minutes');
    //     leftEarlyMinutes = earlyMinutes - (requiredHours * 60)
    // }

    // 6. Calculate Left Early Minutes (based on total working time)
    const requiredMinutes = requiredHours
        ? requiredHours * 60
        : 9 * 60;

    if (workingMinutes > 0 && workingMinutes < requiredMinutes) {
        leftEarlyMinutes = requiredMinutes - workingMinutes;
    }

    // 7. Calculate Extra Hours (CheckOut > ShiftEnd)
    // Requirement: Only calculate time AFTER shift end. Do not include early check-in.
    // if (outMoment && outMoment.isAfter(shiftEndMoment)) {
    //     extraMinutes = outMoment.diff(shiftEndMoment, 'minutes');
    // }

    // const shiftHours = moment(shiftEndStr).diff(moment(shiftEndStr), 'minutes');
    // if (workingMinutes > shiftHours) {
    //     extraMinutes = outMoment.diff(shiftEndMoment, 'minutes');
    // }

    // if (outMoment && outMoment.isAfter(shiftEndMoment)) {
    //     extraMinutes = outMoment.diff(shiftEndMoment, 'minutes');
    // }

    // 7. Calculate Extra Minutes (Hourly vs Full-time)
    if (workingMinutes > 0) {
        const baseMinutes = requiredHours
            ? requiredHours * 60     // Hourly employee
            : 9 * 60;                // Full-time employee

        extraMinutes = workingMinutes - baseMinutes;

        if (extraMinutes < 0) {
            extraMinutes = 0;
        }
    }

    return { lateMinutes, leftEarlyMinutes, extraMinutes, workingMinutes, status, isPaid: false };
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

const isHoliday = async (day) => {
    const [rows] = await con.execute(`SELECT * FROM Holidays WHERE HolidayDate=? AND IsPaid=1`, [day]);
    return rows.length ? rows[0] : null;
}

const getApprovedLeave = async (userID, day) => {
    const [rows] = await con.execute(`
        SELECT lr.*, lt.IsPaid
        FROM LeaveRequests lr
        JOIN LeaveTypes lt ON lr.LeaveTypeID = lt.ID
        WHERE lr.UserID=?
            AND lr.Status='Approved'
            AND ? BETWEEN lr.StartDate AND lr.EndDate
        LIMIT 1
    `, [userID, day]);

    return rows[0] || null;
}

// -------------------- Helper Function for Leave/Holiday --------------------
const applyLeaveHolidayRules = (metrics, leave, holiday) => {
    if (holiday) {
        metrics.status = 'Holiday';
        metrics.holidayTitle = holiday.Title;
        metrics.workingMinutes = 0;
        metrics.isPaid = true;
    } else if (leave) {
        metrics.status = leave.IsPaid ? 'Paid Leave' : 'Unpaid Leave';
        metrics.workingMinutes = 0;
        metrics.isPaid = leave.IsPaid === 1;
    }

    if (metrics.status === 'Paid Leave' || metrics.status === 'Holiday' || metrics.status === 'Unpaid Leave') {
        metrics.lateMinutes = 0;
        metrics.leftEarlyMinutes = 0;
        metrics.extraMinutes = 0;
    }

    return metrics;
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
            const metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

            // Calculate all metrics using the new logic
            const holiday = await isHoliday(day);
            const leave = await getApprovedLeave(user.UserID, day);

            metrics = applyLeaveHolidayRules(metrics, leave, holiday);

            results.push({
                UserID: user.UserID,
                Name: user.Name,
                ProfilePicture: user.ProfilePicture,
                DepartmentName: user.DepartmentName,
                DesignationTitle: user.DesignationTitle,
                CheckIn: checkIn,
                CheckOut: checkOut,
                Status: metrics.status,
                HolidayTitle: metrics.holidayTitle ? metrics.holidayTitle : null,
                LateMinutes: metrics.lateMinutes,
                LeftEarlyMinutes: metrics.leftEarlyMinutes, // New Field
                WorkingMinutes: metrics.workingMinutes,
                ExtraHours: metrics.extraMinutes, // Updated Logic
                shiftStart,
                shiftEnd,
                PaidDay: metrics.status === 'Paid Leave' || metrics.status === 'Holiday',
                DayType: metrics.status // Explicit for UI
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
    if (!userID || !startDate || !endDate) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

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

        // Fetch leaves & holidays once
        const [leavesRows] = await con.execute(`
            SELECT StartDate, EndDate, Status, IsPaid
            FROM LeaveRequests
            WHERE UserID=? AND Status='Approved'
              AND (StartDate <= ? AND EndDate >= ?)
        `, [userID, endDate, startDate]);

        const [holidaysRows] = await con.execute(` SELECT HolidayDate, Title, IsPaid FROM Holidays WHERE HolidayDate BETWEEN ? AND ? `, [startDate, endDate]);

        // Map leaves & holidays
        const leaveMap = {};
        leavesRows.forEach(l => {
            let cur = moment.max(moment(l.StartDate), moment(startDate));
            const last = moment.min(moment(l.EndDate), moment(endDate));
            while (cur.isSameOrBefore(last, 'day')) {
                leaveMap[cur.format('YYYY-MM-DD')] = l;
                cur.add(1, 'day');
            }
        });

        const holidayMap = {};
        holidaysRows.forEach(h => {
            holidayMap[moment(h.HolidayDate).format('YYYY-MM-DD')] = h;
        });

        const results = [];
        let curDate = moment(startDate);
        const end = moment(endDate);
        const requiredHours = await getHourlyRequiredHours(user.UserID);

        while (curDate.isSameOrBefore(end, 'day')) {
            const day = curDate.format('YYYY-MM-DD');
            const weekday = curDate.day(); // 0 = Sunday, 6 = Saturday

            const shift = await getUserShift(user.UserID, day);
            const shiftStart = shift?.StartTime;
            const shiftEnd = shift?.EndTime;

            let checkIn = null, checkOut = null;
            if (shiftStart) {
                const io = await getCheckInOut(user.UserID, shiftStart, day);
                checkIn = io.checkIn;
                checkOut = io.checkOut;
            }

            // Calculate metrics
            let metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

            // Apply leave & holiday rules
            const leave = leaveMap[day] || null;
            const holiday = holidayMap[day] || null;
            metrics = applyLeaveHolidayRules(metrics, leave, holiday);

            // **Force weekend detection BEFORE default Absent**
            if (!leave && !holiday && (weekday === 0 || weekday === 6)) {
                metrics.status = 'Weekend';
                metrics.lateMinutes = 0;
                metrics.leftEarlyMinutes = 0;
                metrics.workingMinutes = 0;
                metrics.extraMinutes = 0;
            } else if (!shiftStart && !leave && !holiday && metrics.status === 'Absent') {
                metrics.status = 'Absent';
            }

            results.push({
                UserID: user.UserID,
                Name: user.Name,
                ProfilePicture: user.ProfilePicture,
                DepartmentName: user.DepartmentName,
                DesignationTitle: user.DesignationTitle,
                CheckIn: checkIn,
                CheckOut: checkOut,
                Status: metrics.status,
                HolidayTitle: metrics.holidayTitle ? metrics.holidayTitle : null,
                LateMinutes: metrics.lateMinutes,
                LeftEarlyMinutes: metrics.leftEarlyMinutes,
                WorkingMinutes: metrics.workingMinutes,
                ExtraHours: metrics.extraMinutes,
                Date: day,
                PaidDay: metrics.status === 'Paid Leave' || metrics.status === 'Holiday',
                DayType: metrics.status
            });

            curDate.add(1, 'day');
        }

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});



router.get('/user-bk', async (req, res) => {
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
            let metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

            const holiday = await isHoliday(day);
            const leave = await getApprovedLeave(user.UserID, day);

            metrics = applyLeaveHolidayRules(metrics, leave, holiday);

            results.push({
                UserID: user.UserID,
                Name: user.Name,
                ProfilePicture: user.ProfilePicture,
                DepartmentName: user.DepartmentName,
                DesignationTitle: user.DesignationTitle,
                CheckIn: checkIn,
                CheckOut: checkOut,
                Status: metrics.status,
                HolidayTitle: metrics.holidayTitle ? metrics.holidayTitle : null,
                LateMinutes: metrics.lateMinutes,
                LeftEarlyMinutes: metrics.leftEarlyMinutes, // New Field
                WorkingMinutes: metrics.workingMinutes,
                ExtraHours: metrics.extraMinutes, // Updated Logic
                Date: day,
                PaidDay: metrics.status === 'Paid Leave' || metrics.status === 'Holiday',
                DayType: metrics.status // Explicit for UI
            });

            curDate.add(1, 'day');
        }

        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/range-with-salary', async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate)
        return res.status(400).json({ error: 'Missing parameters' });

    try {
        // 1. Get all active users
        const [users] = await con.execute(`
            SELECT u.ID AS UserID, u.Name, u.ProfilePicture,
                   d.DepartmentName, des.DesignationTitle
            FROM UserDetails u
            LEFT JOIN Departments d ON u.DepartmentID = d.ID
            LEFT JOIN Designations des ON u.DesignationID = des.ID
            WHERE u.Status='Active' AND d.ID != 5
        `);

        const results = [];
        const startMoment = moment(startDate, "YYYY-MM-DD", true);
        const endMoment = moment(endDate, "YYYY-MM-DD", true);

        if (!startMoment.isValid() || !endMoment.isValid()) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        for (const user of users) {
            // 2. Fetch salary for this user covering the period
            const [salaryRows] = await con.execute(`
                SELECT Salary, FromDate, TillDate
                FROM SalaryRecords
                WHERE EmpID = ?
                  AND FromDate <= ?
                  AND (TillDate IS NULL OR TillDate >= ?)
                ORDER BY FromDate DESC
                LIMIT 1
            `, [user.UserID, endDate, startDate]);

            const salaryRecord = salaryRows[0] || null;
            const salary = salaryRecord?.Salary || 0;

            // 3. Loop through each day in range and calculate attendance
            let curDate = startMoment.clone();
            while (curDate <= endMoment) {
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

                // Calculate attendance metrics
                const metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day);

                const holiday = await isHoliday(day);
                const leave = await getApprovedLeave(user.UserID, day);

                metrics = applyLeaveHolidayRules(metrics, leave, holiday);

                const requiredMinutes = requiredHours ? requiredHours * 60 : 9 * 60;

                let payableMinutes = 0;

                if (metrics.status === 'Present' || metrics.status === 'Left without checkout') {
                    payableMinutes = metrics.workingMinutes;
                }

                if (metrics.status === 'Paid Leave' || metrics.status === 'Holiday') {
                    payableMinutes = requiredMinutes;
                }

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
                    LeftEarlyMinutes: metrics.leftEarlyMinutes,
                    WorkingMinutes: metrics.workingMinutes,
                    RequiredMinutes: requiredHours ? requiredHours * 60 : 9 * 60,
                    ExtraHours: metrics.extraMinutes,
                    Date: day,
                    Salary: salary,
                    PaidDay: metrics.status === 'Paid Leave' || metrics.status === 'Holiday',
                    DayType: metrics.status // Explicit for UI

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

router.post('/apply-for-leave', async (req, res) => {
    const { userID, startDate, endDate, reason } = req.body;
    await con.execute(` INSERT INTO LeaveRequests (UserID, StartDate, EndDate, Reason) VALUES (?,?,?,?);`, [userID, startDate, endDate, reason]);
    res.json('Leave applied successfully');
});

router.post('/leave-action', async (req, res) => {
    const { leaveID, status, approvedBy } = req.body;
    await con.execute(` UPDATE LeaveRequests SET Status=?, ApprovedBy=?, ApprovedAt=NOW() WHERE ID=? `, [status, approvedBy, leaveID]);
    res.json({ message: `Leave ${status}` });
});

router.post('/holidays', async (req, res) => {
    const { title, date } = req.body;
    await con.execute(`INSERT INTO Holidays (Title, HolidayDate) VALUES (?,?)`, [title, date]);
    res.json({ message: 'Holiday added' });
});

router.get('/user-leaves', async (req, res) => {
    try {
        const { userID, startDate, endDate } = req.query;

        if (!userID || !startDate || !endDate) {
            return res.status(400).json({ message: 'userID, startDate, and endDate are required' });
        }

        const [rows] = await con.execute(
            `SELECT StartDate, EndDate, IsPaid, Status FROM LeaveRequests WHERE UserID = ?`,
            [userID]
        );

        const leaves = [];

        rows.forEach(leave => {
            const start = moment(leave.StartDate).isAfter(moment(startDate)) ? moment(leave.StartDate) : moment(startDate);
            const end = moment(leave.EndDate).isBefore(moment(endDate)) ? moment(leave.EndDate) : moment(endDate);

            let current = start.clone();

            while (current.isSameOrBefore(end, 'day')) {
                leaves.push({
                    Date: current.format('YYYY-MM-DD'),
                    Status: leave.Status,
                    IsPaid: leave.IsPaid
                });
                current.add(1, 'day');
            }
        });

        res.json(leaves);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get holidays within a date range
router.get('/holidays', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'startDate and endDate are required' });
        }

        const [rows] = await con.execute(
            `SELECT HolidayDate, Title, IsPaid FROM Holidays WHERE HolidayDate BETWEEN ? AND ?`,
            [startDate, endDate]
        );

        const holidays = rows.map(h => ({
            Date: moment(h.HolidayDate).format('YYYY-MM-DD'),
            Title: h.Title,
            IsPaid: h.IsPaid
        }));

        res.json(holidays);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;