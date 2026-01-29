require("dotenv").config();
const express = require("express");
const { con } = require("../database");
const bodyParser = require("body-parser");
const axios = require("axios");
const Twilio = require("twilio");

const router = express.Router();
const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_APP_SID, TWILIO_AUTH_TOKEN } = process.env;

const upateCallLog = async (status = "", callSid, transcripts) => {
    try {
        await con.query(`UPDATE CallLogs SET Status = ?, Transcripts = ? WHERE CallSID = ?`, [status, JSON.stringify(transcripts), callSid]);
    } catch (err) {
        console.error("Error:", err);
    }
};

router.get("/token", async (req, res) => {
    try {
        const platform = process.env.DIALING_PLATFORM || "Twilio";
        const identity = String(req.user?.ID || "agent") + "_" + Math.floor(Math.random() * 10000);
        if (platform === "Telnyx") {
            const { data: tokenResponse } = await axios.post("https://api.telnyx.com/v2/telephony_credentials/default/token",
                {}, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );

            return res.json({
                platform: "Telnyx",
                token: tokenResponse.data, // This is the JWT for Telnyx RTC
                identity,
                telnyx_connection_id: process.env.TELNYX_CONNECTION_ID // Needed for the frontend SDK
            });

        } else {
            // Existing Twilio Logic
            const token = new AccessToken(
                TWILIO_ACCOUNT_SID,
                TWILIO_API_KEY_SID,
                TWILIO_API_KEY_SECRET,
                { identity }
            );

            token.addGrant(
                new VoiceGrant({
                    outgoingApplicationSid: TWILIO_APP_SID,
                    incomingAllow: true
                })
            );

            return res.json({
                platform: "Twilio",
                token: token.toJwt(),
                identity
            });
        }
    } catch (err) {
        console.error("Token generation error:", err.message);
        res.status(500).json({ error: "Token generation failed" });
    }
});

router.post("/end", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, disposition, callbackDateTime, callbackComments, transcripts, isCallback, callbackID } = req.body;

        if (!callSid || !disposition) {
            return res.status(400).json({ error: "callSid and disposition are required" });
        }

        // 1️⃣ Handle callback creation
        const callbackDispositions = ["Call back later", "Follow-up scheduled", "Appointment booked", "Demo scheduled"];

        if (callbackDispositions.includes(disposition)) {
            await con.query(
                `INSERT INTO Callbacks (UserID, CallSID, Status, DateTime, Comments) VALUES (?, ?, ?, ?, ?)`,
                [req.user.ID, callSid, disposition, callbackDateTime, callbackComments]
            );
        }

        // 2️⃣ Update existing callback history (if this call itself was a callback)
        if (isCallback && callbackID) {
            const [[row]] = await con.query(`SELECT CallingHistory FROM Callbacks WHERE ID = ?`, [callbackID]);

            let history = [];
            if (row?.CallingHistory) {
                history = row.CallingHistory;
            }

            history.push({
                callSid,
                status: disposition,
                dateTime: new Date().toISOString()
            });

            await con.query(`UPDATE Callbacks SET CallingHistory = ? WHERE ID = ?`, [JSON.stringify(history), callbackID]);
        }

        // 3️⃣ Update dialing data
        await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [disposition, callSid]);

        // 4️⃣ Update call log
        await upateCallLog(disposition, callSid, transcripts || null);

        return res.json({ success: true });
    } catch (err) {
        console.error("POST /end error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.get("/next", async (req, res) => {
    const { ID } = req.user;
    const connection = await con.getConnection(); // Get a dedicated connection for the transaction
    try {
        await connection.beginTransaction();
        const [rows] = await connection.query(`SELECT * FROM DialingData WHERE (Status IS NULL OR Status = '') ORDER BY LeadID DESC LIMIT 1 FOR UPDATE SKIP LOCKED `);

        if (!rows || rows.length === 0) {
            await connection.rollback();
            return res.json({ success: true, number: null, message: "List finished." });
        }

        const row = rows[0];
        const cleaned = (row.Phone || "").replace(/\D/g, "");

        if (cleaned.length !== 10) {
            await connection.query(`UPDATE DialingData SET Status = 'Invalid number' WHERE LeadID = ?`, [row.LeadID]);
            await connection.commit();
            connection.release();
            return res.redirect("/next");
        }

        await connection.query(`UPDATE DialingData SET Status = 'Dialing', DialedBy = ? WHERE LeadID = ?`, [ID, row.LeadID]);

        await connection.commit();
        connection.release();

        return res.json({ success: true, number: cleaned, details: row });

    } catch (err) {
        await connection.rollback();
        connection.release();
        res.status(500).json({ error: err.message });
    }
});

router.get("/recording", async (req, res) => {
    const { recordingURL, platform } = req.query;

    try {
        let axiosConfig = { responseType: "stream" };

        if (platform === "Telnyx") {
            axiosConfig.headers = {
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            };
        } else {
            axiosConfig.auth = {
                username: TWILIO_ACCOUNT_SID,
                password: TWILIO_AUTH_TOKEN,
            };
        }

        // 3. Fetch and Pipe
        const response = await axios.get(recordingURL, axiosConfig);

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", "inline; filename=recording.mp3");
        response.data.pipe(res);

    } catch (error) {
        console.error("Recording Fetch Error:", error.message);
        res.status(500).json({ error: "Failed to fetch recording" });
    }
});

router.get("/recording-old", async (req, res) => {
    const { recordingURL } = req.query;
    try {
        const response = await axios.get(recordingURL, {
            responseType: "stream",
            auth: {
                username: TWILIO_ACCOUNT_SID,
                password: TWILIO_AUTH_TOKEN,
            },
        });

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", "inline; filename=recording.mp3");
        response.data.pipe(res);
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ error: "Failed to fetch recording" });
    }
});

router.post("/update-dialing-data", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, leadID, isCallback } = req.body;

        if (isCallback) return res.json({ success: true });

        await con.query(`UPDATE DialingData SET CallSID = ? WHERE LeadID = ?;`, [callSid, leadID]);
        return res.json({ success: true });
    } catch (err) {
        console.log(err.message)
        res.status(500).json({ error: err.message });
    }
});

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
        LEFT JOIN DialingData ON DialingData.CallSID = CallLogs.CallSID
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