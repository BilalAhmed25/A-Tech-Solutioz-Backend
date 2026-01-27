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
            DATE_FORMAT(CallLogs.DialedOn, '%Y-%m-%d %H:%i:%s') AS DialedOn,
            UserDetails.ID,
            UserDetails.Name,
            UserDetails.Email,
            UserDetails.ProfilePicture,
            DialingData.Name AS LeadName,
            DialingData.Email AS ClientEmail,
            DialingData.LeadType,
            DialingData.Budget,
            DialingData.Comments
        FROM CallLogs
        JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID
        LEFT JOIN DialingData ON CallLogs.CallSID = DialingData.CallSID
    `;

    let params = [];

    // If NOT admin department, restrict to self
    if (DepartmentID !== 5) {
        query += " WHERE CallLogs.DialedBy = ? AND CallLogs.DialedOn BETWEEN ? AND ? ORDER BY CallLogs.ID DESC";
        params.push(ID, range.startDate, range.endDate);
    } else {
        if (type == "1") {
            query += `
            WHERE CallLogs.DialedBy = ?
            AND CallLogs.DialedOn BETWEEN ? AND ?
            ORDER BY CallLogs.ID DESC
        `;
            params.push(selectedProfile, range.startDate, range.endDate);

        } else if (type == "2") {
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
                DATE_FORMAT(CallLogs.DialedOn, '%Y-%m-%d %H:%i:%s') AS DialedOn,
                UserDetails.ID,
                UserDetails.Name,
                UserDetails.Email,
                UserDetails.ProfilePicture,
                DialingData.Name AS LeadName,
                DialingData.Email,
                DialingData.LeadType,
                DialingData.Budget,
                DialingData.Comments
            FROM CallLogs
            JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID
            LEFT JOIN DialingData ON DialingData.CallSID = CallLogs.CallSID
            WHERE DialingData.FileID = ?
            ORDER BY CallLogs.ID DESC
        `;
            params = [selectedFile];

        } else {
            // ✅ FIXED PART
            query += `
            WHERE CallLogs.DialedOn BETWEEN ? AND ?
            ORDER BY CallLogs.ID DESC
        `;
            params.push(range.startDate, range.endDate);
        }
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/callbacks", async (req, res) => {
    const { ID, DepartmentID } = req.user;
    const { range, selectedProfile } = req.query.filters || {};

    let query = `
        SELECT 
            Callbacks.ID,
            Callbacks.UserID,
            Callbacks.CallSID,
            Callbacks.Status,
            Callbacks.DateTime,
            Callbacks.Comments,
            Callbacks.CallingHistory,

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

    const hasValidRange =
        range &&
        typeof range === "object" &&
        range.startDate &&
        range.endDate;

    // 🔐 Normal user → own callbacks
    if (DepartmentID !== 5) {
        conditions.push("Callbacks.UserID = ?");
        params.push(ID);
    }

    // 👑 Admin → profile filter
    if (DepartmentID === 5 && selectedProfile) {
        conditions.push("Callbacks.UserID = ?");
        params.push(selectedProfile);
    }

    // 📅 Date range filter (FIXED)
    if (hasValidRange) {
        conditions.push("Callbacks.DateTime BETWEEN ? AND ?");
        params.push(range.startDate, range.endDate);
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

router.get("/krisp-status", async (req, res) => {
    try {
        const [result] = await con.execute("SELECT * FROM UserSettings WHERE UserID = ? AND KrispEnabled = 1", [req.query.ID]);
        console.log(result)
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;