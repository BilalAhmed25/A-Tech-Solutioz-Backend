require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_APP_SID, TWILIO_AUTH_TOKEN } = process.env;

function normalizePhone(p) {
    if (p === null || p === undefined) return "";
    return String(p).replace(/\D/g, "");
}

const insertCallLog = async (phone, dialedBy, callSid) => {
    try {
        const normalized = normalizePhone(phone);
        await con.query(`INSERT INTO CallLogs (Phone, CallSID, DialedBy) VALUES (?, ?, ?)`, [normalized, callSid, dialedBy]);
    } catch (err) {
        console.error("Error:", err);
    }
};

const upateCallLog = async (status = "", duration = 0, callSid, transcripts = "") => {
    try {
        await con.query(`UPDATE CallLogs SET Status = ?, Duration = ?, Transcripts = ? WHERE CallSID = ?`, [status, duration, transcripts, callSid]);
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

router.get("/next", async (req, res) => {
    const { ID } = req.user;
    try {
        const getNextLead = async () => {
            const [rows] = await con.query(
                `SELECT * FROM DialingData WHERE (Status IS NULL OR Status = '') ORDER BY LeadID ASC LIMIT 1`
            );

            if (!rows || rows.length === 0) return null;
            return rows[0];
        };

        let row = await getNextLead();
        if (!row) { return res.json({ success: true, number: null, message: "List finished." }); }

        // Loop until a valid number is found
        while (row) {
            const rawPhone = row.Phone || "";

            // Validate US Phone (digits only, 10 digits)
            const cleaned = rawPhone.replace(/\D/g, "");
            const isValidUS = cleaned.length === 10;  // Simple validation

            if (!isValidUS) {
                // Mark invalid
                await con.query(`UPDATE DialingData SET Status = 'Invalid Number' WHERE LeadID = ?`, [row.LeadID]);
                // Check next row
                row = await getNextLead();
                continue;
            } else {
                await con.query(`UPDATE DialingData SET Status = 'Dialing', DialedBy = ? WHERE LeadID = ?`, [ID, row.LeadID]);
            }

            return res.json({ success: true, number: cleaned, details: row });
        }
        return res.json({ success: true, number: null, message: "No valid number available." });
    } catch (err) {
        console.error("GET /next error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/attach-callsid", bodyParser.json(), async (req, res) => {
    try {
        const { id, callSid, phoneNumber } = req.body;
        const dialedBy = req.user?.ID;
        if (id) {
            await con.query(`UPDATE DialingData SET CallSID = ? WHERE LeadID = ? AND DialedBy = ?;`, [callSid, id, dialedBy]);
        }
        await insertCallLog(phoneNumber, dialedBy, callSid);
        return res.json({ success: true });
    } catch (err) {
        console.error("attach-callsid error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/end", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, disposition, duration, callbackDateTime, callbackComments, transcripts } = req.body;
        if (!disposition || !callSid) return res.status(400).json({ error: "disposition and callSid are required." });
        if (disposition === 'Callback later') {
            await con.query(`INSERT INTO Callbacks (UserID, CallSID, DateTime, Comments) VALUES (?, ?, ?, ?);`, [req.user.ID, callSid, callbackDateTime, callbackComments]);
        }
        await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?;`, [disposition, callSid]);
        await upateCallLog(disposition, duration, callSid, transcripts);
        return res.json({ success: true });
    } catch (err) {
        console.error("POST /end error:", err);
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

module.exports = router;