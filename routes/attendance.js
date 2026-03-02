const express = require('express');
const router = express.Router();
const { con, attendanceDB } = require('../database');
const moment = require('moment');

// -------------------- Helper Functions --------------------

// Centralized logic to calculate all metrics for a specific day
function calculateDailyMetrics(checkIn, checkOut, shiftStartStr, shiftEndStr, requiredHours, dayDate, isHourlyEmployee = false) {
    // Defaults
    let lateMinutes = 0;
    let leftEarlyMinutes = 0;
    let extraMinutes = 0;
    let workingMinutes = 0;
    let status = 'Absent';

    if (checkIn) {
        status = 'Present';
        if (!checkOut) status = 'Left without checkout';
    }

    if (!shiftStartStr || !shiftEndStr) {
        if (checkIn && checkOut) {
            workingMinutes = moment(checkOut).diff(moment(checkIn), 'minutes');
        }
        return { lateMinutes, leftEarlyMinutes, extraMinutes, workingMinutes, status };
    }

    const shiftStartMoment = moment(`${dayDate} ${shiftStartStr}`, 'YYYY-MM-DD HH:mm:ss', true);
    let shiftEndMoment = moment(`${dayDate} ${shiftEndStr}`, 'YYYY-MM-DD HH:mm:ss', true);

    if (shiftEndMoment.isBefore(shiftStartMoment)) {
        shiftEndMoment.add(1, 'day');
    }

    const inMoment = checkIn ? moment(checkIn) : null;
    const outMoment = checkOut ? moment(checkOut) : null;

    if (inMoment && outMoment) {
        let calcOut = outMoment.clone();
        if (calcOut.isBefore(inMoment)) calcOut.add(1, 'day');
        workingMinutes = calcOut.diff(inMoment, 'minutes');
    }

    // ⚡ Late calculation based on actual IsHourlyEmployee
    if (!isHourlyEmployee && inMoment && inMoment.isAfter(shiftStartMoment)) {
        const lateDiff = inMoment.diff(shiftStartMoment, 'minutes');
        lateMinutes = lateDiff > 15 ? lateDiff : 0;
    }

    const requiredMinutes = requiredHours ? requiredHours * 60 : 9 * 60;

    if (workingMinutes > 0 && workingMinutes < requiredMinutes) {
        leftEarlyMinutes = requiredMinutes - workingMinutes;
    }

    if (workingMinutes > 0) {
        const baseMinutes = requiredHours ? requiredHours * 60 : 9 * 60;
        extraMinutes = workingMinutes - baseMinutes;
        if (extraMinutes < 0) extraMinutes = 0;
    }

    return { lateMinutes, leftEarlyMinutes, extraMinutes, workingMinutes, status, isPaid: false };
}

// Fetch shift info for a user
async function getUserShift(userID, day) {
    const [rows] = await con.execute(`
        SELECT sd.StartTime, sd.EndTime, usa.IsHourlyEmloyee
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
    const query = `
        SELECT
            CASE
                WHEN usa.IsHourlyEmloyee = TRUE THEN he.RequiredHours
                ELSE CAST(
                    TIME_TO_SEC(
                        TIMEDIFF(
                            IF(sd.EndTime <= sd.StartTime,
                                ADDTIME(sd.EndTime, '24:00:00'),
                                sd.EndTime
                            ),
                            sd.StartTime
                        )
                    ) / 3600
                    AS FLOAT
                )
            END AS RequiredHours
            FROM UserShiftAssignments usa
                LEFT JOIN ShiftDurations sd
                    ON usa.ShiftID = sd.ShiftID
                LEFT JOIN HourlyEmployees he
                    ON he.EmployeeID = usa.UserID
            WHERE usa.UserID = ?
            LIMIT 1;
    `;

    const [rows] = await con.execute(query, [userID]);
    return rows[0]?.RequiredHours ?? null;
}

// Fetch check-in and check-out within windows
async function getCheckInOut(userID, shiftStart, day) {
    const shiftStartMoment = moment(`${day}T${shiftStart}`);
    const checkInStart = shiftStartMoment.clone().subtract(3, 'hours');
    // const checkInEnd = shiftStartMoment.clone().add(5, 'hours');
    const checkInEnd = shiftStartMoment.clone().add(7, 'hours');
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

async function isWorkingWeekend(day) {
    const [rows] = await con.execute(`SELECT IsWorkingDay FROM WeekendOverrides WHERE Date = ? LIMIT 1 `, [day]);

    if (!rows.length) return false; // default weekend
    return rows[0].IsWorkingDay === 1;
}

// -------------------- API: /day --------------------
router.get('/day', async (req, res) => {
    const { day } = req.query;
    if (!day) return res.status(400).json({ error: 'Please provide day parameter' });
    const [holiday] = await con.execute(`SELECT * FROM Holidays WHERE HolidayDate = ?`, [day]);
    if (holiday.length > 0) return res.json('Holiday');

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
            const isHourlyEmployee = shift?.IsHourlyEmloyee === 1;
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
            let metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day, isHourlyEmployee);

            // Calculate all metrics using the new logic
            const leave = await getApprovedLeave(user.UserID, day);

            metrics = applyLeaveHolidayRules(metrics, leave, null);

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
                DayType: (metrics.lateMinutes >= 120 || metrics.leftEarlyMinutes >= 120) ? 'Half Day' : metrics.status
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

        const [holidaysRows] = await con.execute(`SELECT HolidayDate, Title, IsPaid FROM Holidays WHERE HolidayDate BETWEEN ? AND ?;`, [startDate, endDate]);

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
            const isHourlyEmployee = shift?.IsHourlyEmloyee === 1;
            const shiftStart = shift?.StartTime;
            const shiftEnd = shift?.EndTime;

            let checkIn = null, checkOut = null;
            if (shiftStart) {
                const io = await getCheckInOut(user.UserID, shiftStart, day);
                checkIn = io.checkIn;
                checkOut = io.checkOut;
            }

            // Calculate metrics
            let metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day, isHourlyEmployee);

            // Apply leave & holiday rules
            const leave = leaveMap[day] || null;
            const holiday = holidayMap[day] || null;
            metrics = applyLeaveHolidayRules(metrics, leave, holiday);

            // **Force weekend detection BEFORE default Absent**
            // if (!leave && !holiday && (weekday === 0 || weekday === 6)) {
            //     metrics.status = 'Weekend';
            //     metrics.lateMinutes = 0;
            //     metrics.leftEarlyMinutes = 0;
            //     metrics.workingMinutes = 0;
            //     metrics.extraMinutes = 0;
            // } else if (!shiftStart && !leave && !holiday && metrics.status === 'Absent') {
            //     metrics.status = 'Absent';
            // }

            const isWeekend = (weekday === 0 || weekday === 6);
            const isWorking = isWeekend ? await isWorkingWeekend(day) : false;

            if (!leave && !holiday && isWeekend && !isWorking) {
                metrics.status = 'Weekend';
                metrics.lateMinutes = 0;
                metrics.leftEarlyMinutes = 0;
                metrics.workingMinutes = 0;
                metrics.extraMinutes = 0;
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
                // DayType: metrics.status
                DayType: (metrics.lateMinutes >= 120 || metrics.leftEarlyMinutes >= 120) ? 'Half Day' : metrics.status
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

    const startMoment = moment(startDate, 'YYYY-MM-DD', true);
    const endMoment = moment(endDate, 'YYYY-MM-DD', true);

    if (!startMoment.isValid() || !endMoment.isValid()) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    try {
        /* =======================
           1️⃣ Fetch active users
        ======================= */
        const [users] = await con.execute(`
            SELECT u.ID AS UserID, u.Name, u.ProfilePicture,
                   d.DepartmentName, des.DesignationTitle
            FROM UserDetails u
            LEFT JOIN Departments d ON u.DepartmentID = d.ID
            LEFT JOIN Designations des ON u.DesignationID = des.ID
            WHERE u.Status='Active' AND d.ID != 5
        `);

        if (!users.length) return res.json([]);

        const userIds = users.map(u => u.UserID);

        /* =======================
           2️⃣ Salaries (latest covering range)
        ======================= */
        const [salaryRows] = await con.execute(`
            SELECT EmpID, Salary, FromDate, TillDate
            FROM SalaryRecords
            WHERE EmpID IN (${userIds.map(() => '?').join(',')})
              AND FromDate <= ?
              AND (TillDate IS NULL OR TillDate >= ?)
            ORDER BY FromDate DESC
        `, [...userIds, endDate, startDate]);

        const salaryMap = {};
        salaryRows.forEach(s => {
            if (!salaryMap[s.EmpID]) salaryMap[s.EmpID] = s;
        });

        /* =======================
           3️⃣ Leaves (bulk)
        ======================= */
        const [leavesRows] = await con.execute(`
            SELECT UserID, StartDate, EndDate, IsPaid
            FROM LeaveRequests
            WHERE Status='Approved'
              AND UserID IN (${userIds.map(() => '?').join(',')})
              AND StartDate <= ?
              AND EndDate >= ?
        `, [...userIds, endDate, startDate]);

        const leaveMap = {};
        leavesRows.forEach(l => {
            let cur = moment.max(moment(l.StartDate), startMoment);
            const last = moment.min(moment(l.EndDate), endMoment);
            while (cur.isSameOrBefore(last, 'day')) {
                leaveMap[`${l.UserID}_${cur.format('YYYY-MM-DD')}`] = l;
                cur.add(1, 'day');
            }
        });

        /* =======================
           4️⃣ Holidays (bulk)
        ======================= */
        const [holidaysRows] = await con.execute(`
            SELECT HolidayDate, Title, IsPaid
            FROM Holidays
            WHERE HolidayDate BETWEEN ? AND ?
        `, [startDate, endDate]);

        const holidayMap = {};
        holidaysRows.forEach(h => {
            holidayMap[moment(h.HolidayDate).format('YYYY-MM-DD')] = h;
        });

        /* =======================
           5️⃣ Cache helpers
        ======================= */
        const shiftCache = {};
        const hoursCache = {};

        const getShiftCached = async (userId, day) => {
            const key = `${userId}_${day}`;
            if (!shiftCache[key]) shiftCache[key] = await getUserShift(userId, day);
            return shiftCache[key];
        };

        const getHoursCached = async (userId) => {
            if (!hoursCache[userId]) {
                hoursCache[userId] = await getHourlyRequiredHours(userId);
            }
            return hoursCache[userId];
        };

        /* =======================
           6️⃣ Attendance calculation
        ======================= */
        const results = [];

        for (const user of users) {
            const salary = salaryMap[user.UserID]?.Salary || 0;
            const requiredHours = await getHoursCached(user.UserID);

            let curDate = startMoment.clone();
            while (curDate.isSameOrBefore(endMoment, 'day')) {
                const day = curDate.format('YYYY-MM-DD');
                const weekday = curDate.day();

                const shift = await getShiftCached(user.UserID, day);
                const isHourlyEmployee = shift?.IsHourlyEmloyee === 1;
                const shiftStart = shift?.StartTime;
                const shiftEnd = shift?.EndTime;

                let checkIn = null, checkOut = null;
                if (shiftStart) {
                    const io = await getCheckInOut(user.UserID, shiftStart, day);
                    checkIn = io.checkIn;
                    checkOut = io.checkOut;
                }

                let metrics = calculateDailyMetrics(checkIn, checkOut, shiftStart, shiftEnd, requiredHours, day, isHourlyEmployee);

                const leave = leaveMap[`${user.UserID}_${day}`] || null;
                const holiday = holidayMap[day] || null;

                /* 🔥 PRIORITY ORDER */
                if (leave) {
                    metrics.status = leave.IsPaid ? 'Paid Leave' : 'Unpaid Leave';
                    metrics.workingMinutes = 0;
                    metrics.lateMinutes = 0;
                    metrics.leftEarlyMinutes = 0;
                    metrics.extraMinutes = 0;
                }
                else if (holiday) {
                    metrics.status = 'Holiday';
                    metrics.holidayTitle = holiday.Title;
                    metrics.workingMinutes = 0;
                }
                else if (weekday === 0 || weekday === 6) {
                    metrics.status = 'Weekend';
                    metrics.workingMinutes = 0;
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
                    HolidayTitle: metrics.holidayTitle || null,
                    LateMinutes: metrics.lateMinutes,
                    LeftEarlyMinutes: metrics.leftEarlyMinutes,
                    WorkingMinutes: metrics.workingMinutes,
                    RequiredHours: requiredHours,
                    ExtraHours: metrics.extraMinutes,
                    Salary: salary,
                    Date: day,
                    PaidDay: ['Paid Leave', 'Holiday'].includes(metrics.status),
                    DayType: metrics.status
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

router.get('/salary-adjustments', async (req, res) => {
    try {
        const { month } = req.query; // format YYYY-MM

        if (!month) {
            return res.status(400).json({ error: 'Missing month parameter' });
        }

        const m = moment(month, 'YYYY-MM', true);
        if (!m.isValid()) {
            return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
        }

        const [rows] = await con.execute(`SELECT UserID, AdjustedAmount, Notes, Month FROM SalaryAdjustments WHERE Month = ?`, [month]);

        res.json(rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
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