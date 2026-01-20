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

const insertCallLog = async (phone, dialedBy, callSid, dialedOn) => {
    try {
        const normalized = normalizePhone(phone);
        await con.query(`INSERT INTO CallLogs (Phone, CallSID, DialedBy, DialedOn) VALUES (?, ?, ?), ?)`, [normalized, callSid, dialedBy, dialedOn]);
    } catch (err) {
        console.error("Error:", err);
    }
};

const upateCallLog = async (status = "", duration = 0, callSid, transcripts) => {
    try {
        await con.query(`UPDATE CallLogs SET Status = ?, Duration = ?, Transcripts = ? WHERE CallSID = ?`, [status, duration, JSON.stringify(transcripts), callSid]);
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

router.post("/insert-call-log", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, leadID, phoneNumber, isCallback, callbackID, dialedOn } = req.body;
        const dialedBy = req.user?.ID;
        await con.query(`INSERT INTO CallLogs (Phone, CallSID, DialedBy, DialedOn) VALUES (?, ?, ?, ?)`, [normalizePhone(phoneNumber), callSid, dialedBy]);
        return res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/auto-end", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, duration, transcripts } = req.body;
        if (!callSid) {
            return res.status(400).json({ error: "callSid is required" });
        }

        await con.query(`UPDATE CallLogs SET Duration = ?, Transcripts = ? WHERE CallSID = ?`, [duration, JSON.stringify(transcripts), callSid]);
        return res.json({ success: true });
    } catch (err) {
        console.error("POST /auto-end error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/end", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, disposition, duration, callbackDateTime, callbackComments, transcripts, isCallback, callbackID } = req.body;

        if (!callSid || !disposition) {
            return res.status(400).json({ error: "callSid and disposition are required" });
        }

        // 1️⃣ Handle callback creation
        const callbackDispositions = ["Call back later", "Follow-up scheduled", "Appointment booked", "Demo scheduled"];

        if (callbackDispositions.includes(disposition)) {
            await con.query(
                `INSERT INTO Callbacks (UserID, CallSID, Status, DateTime, Comments)
                 VALUES (?, ?, ?, ?, ?)`,
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
        await upateCallLog(disposition, duration, callSid, transcripts || null);

        return res.json({ success: true });
    } catch (err) {
        console.error("POST /end error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.get("/next", async (req, res) => {
    const { ID } = req.user;
    try {
        const getNextLead = async () => {
            const [rows] = await con.query(`SELECT * FROM DialingData WHERE (Status IS NULL OR Status = '') ORDER BY LeadID ASC LIMIT 1`);

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
        const { id, callSid, phoneNumber, dialedOn } = req.body;
        const dialedBy = req.user?.ID;
        if (id) {
            await con.query(`UPDATE DialingData SET CallSID = ? WHERE LeadID = ? AND DialedBy = ?;`, [callSid, id, dialedBy]);
        }
        // await insertCallLog(phoneNumber, dialedBy, callSid, dialedOn);
        return res.json({ success: true });
    } catch (err) {
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

router.get("/get-call-status", async (req, res) => {
    const { callSid } = req.query;
    try {
        // Look up the status we just wrote in /amd-status
        const [rows] = await con.query(`SELECT Status FROM CallLogs WHERE CallSID = ? LIMIT 1`, [callSid]);

        if (rows.length > 0) {
            res.json({ status: rows[0].Status });
        } else {
            res.json({ status: "in-progress" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;