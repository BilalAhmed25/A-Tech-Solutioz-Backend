require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const Twilio = require("twilio");
const { con } = require("../database");

const moment = require("moment-timezone");

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

router.get("/token", (req, res) => {
    try {
        const identity = String(req.user?.ID || "agent") + "_" + Math.floor(Math.random() * 10000);
        const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity });

        token.addGrant(
            new VoiceGrant({
                outgoingApplicationSid: TWILIO_APP_SID,
                incomingAllow: true
            })
        );

        res.json({ token: token.toJwt(), identity });
    } catch (err) {
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
        const [rows] = await connection.query(` SELECT * FROM DialingData WHERE (Status IS NULL OR Status = '') ORDER BY LeadID DESC LIMIT 1 FOR UPDATE SKIP LOCKED `);

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

module.exports = router;