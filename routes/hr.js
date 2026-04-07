var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    multer = require('multer'),
    csv = require("csv"),
    router = express.Router();

const { con, attendanceDB } = require('../database');
router.use(bodyParser.urlencoded({ extended: true }));
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/update-employee-status', async function (req, res) {
    const { empID, status } = req.body;
    const sql = "UPDATE UserDetails SET Status = ?  WHERE ID = ?;";
    const [result] = await con.execute(sql, [status, empID]);
    if (result.affectedRows > 0) {
        res.json('Success');
    } else {
        res.status(404).json('Employee not found');
    }
})

router.post('/update-employee-department', async function (req, res) {
    const { empID, department } = req.body;
    const sql = "UPDATE UserDetails SET DepartmentID = ? WHERE ID = ?;";
    const [result] = await con.execute(sql, [department, empID]);
    if (result.affectedRows > 0) {
        res.json('Success');
    } else {
        res.status(404).json('Employee not found');
    }
})

router.post('/upload-shift-record', async (req, res) => {
    try {
        const { empID, workingShift, startDate } = req.body;

        if (!empID || !workingShift || !startDate) {
            return res.status(400).json("All fields are required.");
        }

        // Fetch active shift (EndDate IS NULL)
        const [existing] = await con.execute("SELECT * FROM UserShiftAssignments WHERE UserID = ? AND EndDate IS NULL LIMIT 1", [empID]);

        if (existing.length > 0) {
            const current = existing[0];

            // CASE 1: Active record exists but ShiftID is NULL → update it
            if (current.ShiftID === null) {
                await con.execute("UPDATE UserShiftAssignments SET ShiftID = ? WHERE ID = ?", [workingShift, current.ID]);
            } else {
                // CASE 2: Active record exists and ShiftID is NOT NULL → close old & insert new
                await con.execute("UPDATE UserShiftAssignments SET EndDate = ? WHERE ID = ?", [startDate, current.ID]);
                await con.execute("INSERT INTO UserShiftAssignments (UserID, ShiftID, StartDate) VALUES (?, ?, ?)", [empID, workingShift, startDate]);
            }
        } else {
            // CASE 3: No active shift exists → insert new
            await con.execute("INSERT INTO UserShiftAssignments (UserID, ShiftID, StartDate) VALUES (?, ?, ?)", [empID, workingShift, startDate]);
        }

        res.json("Successfully uploaded shift record.");
    } catch (error) {
        console.error(error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.post('/upload-shift-record-old', async (req, res) => {
    try {
        const { empID, workingShift, startDate } = req.body;

        if (!empID || !workingShift || !startDate) {
            return res.status(400).json("All fields are required.");
        }

        // Check for existing active shift (with EndDate IS NULL)
        const [existing] = await con.execute('SELECT * FROM UserShiftAssignments WHERE UserID = ? AND EndDate IS NULL LIMIT 1', [empID]);

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

function convertDMYtoMySQL(dateStr) {
    // Example input: "29-11-25 23:37"
    if (!dateStr) return null;

    const [datePart, timePart = "00:00"] = dateStr.split(" ");
    const [dd, mm, yy] = datePart.split("-");

    if (!dd || !mm || !yy) return null;

    const fullYear = yy.length === 2 ? `20${yy}` : yy; // convert 25 -> 2025

    return `${fullYear}-${mm}-${dd} ${timePart}:00`;
}

router.post("/upload-attendance", upload.single("file"), async (req, res) => {
    try {
        const { mapping } = req.body;
        if (!mapping) {
            return res.status(400).json({ error: "Column mapping is required." });
        }

        // 1. Parse mapping JSON
        let mappingObj;
        try {
            mappingObj = typeof mapping === "string" ? JSON.parse(mapping) : mapping;
        } catch {
            return res.status(400).json({ error: "Invalid mapping format" });
        }

        const allowedColumns = ["emp_code", "punch_time"];
        const mappedColumns = Object.values(mappingObj).filter(Boolean);

        for (const col of mappedColumns) {
            if (!allowedColumns.includes(col)) {
                return res.status(400).json({ error: `Invalid mapped column: ${col}` });
            }
        }

        // 2. Validate file
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });

        // 3. Parse CSV
        const csvData = file.buffer.toString("utf8");
        const rows = [];
        csv.parse(csvData, { columns: true, trim: true })
            .on("data", (row) => rows.push(row))
            .on("end", async () => {
                try {
                    if (rows.length === 0) {
                        return res.status(400).json({ error: "CSV file is empty" });
                    }

                    // 4. Prepare ONE bulk INSERT for all rows
                    const dbCols = Object.values(mappingObj).filter(Boolean);
                    const csvCols = Object.keys(mappingObj);

                    const sqlColumns = dbCols.map(col => `\`${col}\``).join(", ");

                    const values = [];
                    const valuePlaceholders = rows.map(row => {
                        // const rowValues = csvCols.map(csvCol => row[csvCol] ?? null);
                        const rowValues = csvCols.map(csvCol => {
                            let value = row[csvCol] ?? null;
                            if (mappingObj[csvCol] === "punch_time") {
                                value = convertDMYtoMySQL(value);
                            }
                            return value;
                        });
                        values.push(...rowValues);
                        return "(" + new Array(dbCols.length).fill("?").join(", ") + ")";
                    });

                    const bulkInsertSQL = ` INSERT INTO iclock_transaction (${sqlColumns}) VALUES ${valuePlaceholders.join(", ")} `;
                    // Execute ONE query for all rows
                    await attendanceDB.query(bulkInsertSQL, values);

                    return res.json({
                        message: "Attendance uploaded successfully.",
                        totalInserted: rows.length
                    });

                } catch (err) {
                    console.error("Bulk Insert Error:", err);
                    return res.status(500).json({ error: "Failed to insert data into database" });
                }
            })
            .on("error", (err) => {
                console.error("CSV Parse Error:", err);
                return res.status(500).json({ error: "Failed to parse CSV file" });
            });

    } catch (err) {
        console.error("Upload error:", err);
        return res.status(500).json({ error: "Upload failed" });
    }
});

module.exports = router;