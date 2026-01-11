require("dotenv").config();
const express = require("express");
const { con } = require("../database");

const router = express.Router();

router.get("/logs", async (req, res) => {
    const { ID, DepartmentID } = req.user;
    const { type, selectedProfile, selectedFile, range } = req.query.filters;

    let query = `
        SELECT
            CallLogs.Phone,
            CallLogs.CallSID,
            CallLogs.RecordingSid,
            CallLogs.RecordingUrl,
            CallLogs.AISentiment,
            CallLogs.AISummary,
            CallLogs.Status,
            CallLogs.Duration,
            CallLogs.DialedOn,
            UserDetails.ID,
            UserDetails.Name,
            UserDetails.Email,
            UserDetails.ProfilePicture
        FROM CallLogs
        JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID
    `;

    let params = [];

    // If NOT admin department, restrict to self
    if (DepartmentID !== 5) {
        query += " WHERE CallLogs.DialedBy = ? AND CallLogs.DialedOn BETWEEN ? AND ? ORDER BY CallLogs.ID DESC";
        params.push(ID, range.startDate, range.endDate);
    } else {
        if (type != 0) {
            if (type == "1") {
                // Admin: Type 1 = Profile-based logs
                if (!selectedProfile || !range) {
                    return res.status(400).json({ error: "selectedProfile and range are required" });
                }
                query += ` WHERE CallLogs.DialedBy = ? AND CallLogs.DialedOn BETWEEN ? AND ? ORDER BY CallLogs.ID DESC;`;
                params.push(selectedProfile, range.startDate, range.endDate);
            } else {
                // Admin: Type ≠ 2 → Fetch file details
                if (!selectedFile) return res.status(400).json({ error: "selectedFile is required" });
                query = `
                    SELECT 
                        DialingData.Phone, 
                        DialingData.CallSID, 
                        CallLogs.RecordingSid, 
                        CallLogs.RecordingUrl, 
                        CallLogs.AISentiment, 
                        CallLogs.AISummary, 
                        CallLogs.Status, 
                        CallLogs.Duration, 
                        CallLogs.DialedOn, 
                        UserDetails.ID, 
                        UserDetails.Name, 
                        UserDetails.Email, 
                        UserDetails.ProfilePicture
                    FROM CallLogs
                    JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID JOIN DialingData ON DialingData.CallSID = CallLogs.CallSID WHERE DialingData.FileID = ?  ORDER BY CallLogs.ID DESC;
                `;
                params = [selectedFile];
            }
        } else {
            query += " ORDER BY CallLogs.ID DESC";
        }
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/callbacks", async (req, res) => {
    const { ID, DepartmentID } = req.user;
    const { range, selectedProfile } = req.query.filters;

    let query = `
        SELECT 
            Callbacks.ID,
            Callbacks.UserID,
            Callbacks.CallSID,
            Callbacks.Status,
            Callbacks.DateTime,
            Callbacks.Comments,
            Callbacks.CalingHistory,

            UserDetails.Name,
            UserDetails.Email,
            UserDetails.ProfilePicture,

            CallLogs.Phone,
            CallLogs.Duration,
            CallLogs.AISummary,
            CallLogs.AISentiment,
            CallLogs.RecordingUrl,
            CallLogs.RecordingSid,
            CallLogs.Transcripts,
            CallLogs.DialedOn

        FROM Callbacks
        JOIN UserDetails 
            ON Callbacks.UserID = UserDetails.ID
        LEFT JOIN CallLogs 
            ON CallLogs.CallSID = Callbacks.CallSID
    `;

    const params = [];
    const conditions = [];

    // 🔐 Normal user → only own callbacks
    if (DepartmentID !== 5) {
        conditions.push("Callbacks.UserID = ?");
        params.push(ID);
    }

    // 👑 Admin → optional profile filter
    if (DepartmentID === 5 && selectedProfile) {
        conditions.push("Callbacks.UserID = ?");
        params.push(selectedProfile);
    }

    if (conditions.length) {
        query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY Callbacks.DateTime DESC";

    try {
        const [rows] = await con.execute(query, params);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Error fetching callbacks:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/call-dispositions", async (req, res) => {
    try {
        const [result] = await con.execute("SELECT * FROM CallDispositions");
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;