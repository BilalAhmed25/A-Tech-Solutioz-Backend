var express = require('express'),
    multer = require('multer'),
    cloudinary = require('../cloudinaryConfig'),
    router = express.Router(),
    { google } = require("googleapis"),
    { con } = require('../database'),
    csv = require("csv");

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.get('/get-files', async (req, res) => {
    try {
        const { ID, DepartmentID } = req.user;
        let query = "SELECT * FROM `Files`";
        if (DepartmentID !== 5) {
            query += ` WHERE FIND_IN_SET(${ID}, Access) AND FileType != 'google-sheet'`;
        }
        query += " ORDER BY ID DESC;";
        const [result] = await con.execute(query);
        res.json(result);
    } catch (error) {
        console.error("An error occured: ", error);
        res.status(500).json("Internal server error.");
    }
});

router.post("/upload-leads", upload.single("file"), async (req, res) => {
    try {
        const userId = req.user?.ID;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const { mapping } = req.body;
        if (!mapping) return res.status(400).json({ error: "Column mapping is required" });

        // -------------------------------
        // 1. Parse mapping JSON
        // -------------------------------
        let mappingObj;
        if (typeof mapping === "string") {
            try {
                mappingObj = JSON.parse(mapping); // { CSVHeader: DBColumn, ... }
            } catch (err) {
                console.error("Invalid mapping JSON:", mapping);
                return res.status(400).json({ error: "Invalid mapping format" });
            }
        } else if (typeof mapping === "object") {
            mappingObj = mapping;
        } else {
            return res.status(400).json({ error: "Invalid mapping format" });
        }

        // Whitelist of allowed DB columns (adjust to your table schema)
        const allowedColumns = ["Phone", "Name", "Email", "LeadType", "Budget", "Comments"];
        const mappedColumns = Object.values(mappingObj).filter(Boolean);
        for (const col of mappedColumns) {
            if (!allowedColumns.includes(col)) {
                return res.status(400).json({ error: `Invalid mapped column: ${col}` });
            }
        }

        // -------------------------------
        // 2. Validate file
        // -------------------------------
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });

        // Upload to Cloudinary
        const b64 = Buffer.from(file.buffer).toString("base64");
        const dataURI = `data:${file.mimetype};base64,${b64}`;
        const fileExt = file.originalname.split(".").pop();

        const cloudRes = await cloudinary.uploader.upload(dataURI, {
            folder: "leads_files",
            resource_type: "raw",
            format: fileExt,
        });

        // Save file record
        const [insertFile] = await con.query(
            `INSERT INTO Files (FileName, FileType, FileURL, UploadedBy) VALUES (?, ?, ?, ?)`,
            [file.originalname, file.mimetype, cloudRes.secure_url, userId]
        );
        const fileId = insertFile.insertId;

        // -------------------------------
        // 3. Parse CSV
        // -------------------------------
        const csvData = file.buffer.toString("utf8");
        const rows = [];
        csv.parse(csvData, { columns: true, trim: true })
            .on("data", (row) => rows.push(row))
            .on("end", async () => {
                try {
                    const insertPromises = rows.map(async (row) => {
                        const dbCols = [];
                        const values = [];

                        // Map CSV columns to DB columns
                        for (const csvCol in mappingObj) {
                            const dbCol = mappingObj[csvCol];
                            if (!dbCol) continue;
                            dbCols.push(`\`${dbCol}\``); // Escape column name
                            values.push(row[csvCol] ?? null);
                        }

                        // Add FileID
                        dbCols.push("`FileID`");
                        values.push(fileId);

                        const placeholders = dbCols.map(() => "?").join(", ");
                        const sql = `INSERT INTO DialingData (${dbCols.join(", ")}) VALUES (${placeholders})`;

                        return con.query(sql, values);
                    });

                    await Promise.all(insertPromises);
                    return res.json({
                        message: "File and leads uploaded successfully.",
                        fileId,
                        totalInserted: rows.length,
                    });
                } catch (err) {
                    console.error("DB Insert Error:", err);
                    return res.status(500).json({ error: "Failed to insert leads into database" });
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

router.post("/publish-google-sheet", async (req, res) => {
    try {
        const { fileName, fileURL } = req.body;
        if (!fileURL) {
            return res.status(400).json({ error: "Google Sheet URL is required" });
        }

        // Extract Sheet ID
        const match = fileURL.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (!match) {
            return res.status(400).json({ error: "Invalid Google Sheet URL." });
        }

        const sheetId = match[1];

        // Authenticate
        const auth = new google.auth.GoogleAuth({
            keyFile: "./experts-crm-9d6ac1b67e39.json",
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        });

        const sheets = google.sheets({ version: "v4", auth });
        try {
            await sheets.spreadsheets.get({ spreadsheetId: sheetId });
        } catch (err) {
            return res.status(403).json({
                error: "Access denied. Please share the Google Sheet with sheets-reader@experts-crm.iam.gserviceaccount.com.",
                details: err.message
            });
        }

        const query = `INSERT INTO Files (FileName, FileType, FileURL, UploadedBy)VALUES (?, 'google-sheet', ?, ?)`;
        const [result] = await con.execute(query, [fileName, fileURL, req.user.ID]);
        return res.json({ success: true, message: "Google Sheet linked successfully!" });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json("Internal Server Error.");
    }
});

router.post('/update-file-details', async (req, res) => {
    try {
        const { fileName, fileID, access } = req.body;
        const query = "UPDATE `Files` SET FileName = ?, Access = ? WHERE ID = ?";
        const [result] = await con.execute(query, [fileName, access, fileID]);
        res.json('Success');
    } catch (error) {
        console.error("An error occured: ", error);
        res.status(500).json("Internal server error.");
    }
});

router.delete("/delete-lead-file", async (req, res) => {
    const fileId = req.query.fileID;
    const userId = req.user?.ID;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    try {
        // 1. Get file record from DB
        const [rows] = await con.query("SELECT * FROM Files WHERE ID = ?", [fileId]);
        if (!rows.length) return res.status(404).json({ message: "File not found" });
        if (rows[0].UploadedBy !== userId) return res.status(403).json({ message: "You are not authorized to delete this file." });
        if (rows[0].FileType === 'google-sheet') {
            // Just delete from database
            await con.query("DELETE FROM Files WHERE ID = ?", [fileId]);
            return res.json("Google Sheet link deleted successfully.");
        }

        const file = rows[0];
        const fileURL = file.FileURL;

        // 2. Extract public_id from Cloudinary URL
        const regex = /upload\/(?:v\d+\/)?(.+)\.[^.]+$/;
        const match = fileURL.match(regex);
        if (!match) return res.status(400).json({ error: "Invalid Cloudinary URL format" });

        const publicId = match[1]; // e.g. "uploads/sales_data"

        // 3. Delete from Cloudinary
        await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });

        // 4. Delete from database
        await con.query("DELETE FROM DialingData WHERE FileID = ?", [fileId]);
        await con.query("DELETE FROM Files WHERE ID = ?", [fileId]);

        res.json("File deleted successfully.");
    } catch (error) {
        console.error("Delete error: ", error);
        res.status(500).json({ error: "Failed to delete file" });
    }
});

module.exports = router;