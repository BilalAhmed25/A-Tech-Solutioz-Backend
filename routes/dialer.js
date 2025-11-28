require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_APP_SID } = process.env;

/* ---------------- helpers ---------------- */

function normalizePhone(p) {
    if (p === null || p === undefined) return "";
    return String(p).replace(/\D/g, "");
}

/**
 * insertCallLog - idempotent by CallSID when provided.
 * Stores Phone, CallSID, Status, DialedBy, Duration, RecordingUrl, createdAt.
 */
const insertCallLog = async (phone = "", status = "", dialedBy = "", callSid = null, duration = null, recordingUrl = null) => {
    try {
        const normalized = normalizePhone(phone);

        // If CallSID provided, ensure idempotency by CallSID
        if (callSid) {
            const [existing] = await con.query(`SELECT ID FROM CallLogs WHERE CallSID = ? LIMIT 1`, [callSid]);
            if (existing && existing.length > 0) {
                // Update metadata (duration / recordingUrl / status / dialedBy) if more info arrives later
                await con.query(
                    `UPDATE CallLogs SET Status = ?, DialedBy = ?, Duration = ?, RecordingUrl = ? WHERE CallSID = ?`,
                    [status || "", dialedBy || "", duration != null ? Number(duration) : null, recordingUrl || null, callSid]
                );
                return;
            }
        }

        // No CallSID or no existing entry — create a new CallLog record
        await con.query(
            `INSERT INTO CallLogs (Phone, CallSID, Status, DialedBy, Duration, RecordingUrl) VALUES (?, ?, ?, ?, ?, ?)`,
            [normalized || "", callSid || '', status || "", dialedBy || "", duration != null ? Number(duration) : '', recordingUrl || '']
        );
    } catch (err) {
        console.error("insertCallLog error:", err);
    }
};

/* ---------------- /token ---------------- */

router.get("/token", (req, res) => {
    try {
        const identity = String(req.user?.ID || "agent") + "_" + Math.floor(Math.random() * 10000);
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

        res.json({ token: token.toJwt(), identity });
    } catch (err) {
        res.status(500).json({ error: "Token generation failed" });
    }
});


/* ---------------- GET next lead ----------------
   Return normalized phone and full details in 'details'
------------------------------------------------------------------ */
router.get("/next", async (req, res) => {
    try {
        const [rows] = await con.query(
            `SELECT LeadID, Phone, Name, LeadType, Budget, Comments, DialedBy, Status
             FROM DialingData
             WHERE (Status IS NULL OR Status = '')
             ORDER BY LeadID ASC LIMIT 1`
        );

        if (!rows || rows.length === 0) return res.json({ success: true, number: null, message: "List finished." });

        const row = rows[0];
        return res.json({ success: true, number: normalizePhone(row.Phone || ""), details: row });
    } catch (err) {
        console.error("GET /next error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ---------------- POST /start ----------------
   Agent starts dialing (manual or live). Update DialingData.Status='Dialing' only.
   Also insert a CallLog record for manual dials (no CallSID yet).
------------------------------------------------------------------ */
router.post("/start", bodyParser.json(), async (req, res) => {
    try {
        const { number } = req.body;
        const empID = String(req.user?.ID || "agent");
        const phone = normalizePhone(number);

        // Update only Status on DialingData
        await con.query(`UPDATE DialingData SET Status = 'Dialing', DialedBy = ? WHERE Phone = ?`, [empID, phone]);

        // Insert CallLog for manual dial (no CallSID yet)
        await insertCallLog(phone, "dialing", empID, null, null, null);

        return res.json({ success: true, locked: true });
    } catch (err) {
        console.error("POST /start error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ---------------- attach-callsid ----------------
   - DO NOT touch DialingData except Status (as rule).
   - This endpoint will ensure CallSID is recorded on CallLogs.
   - If an existing CallLog for the phone exists without CallSID, it will update that record.
   - Otherwise it will insert a new CallLog with the CallSID.
------------------------------------------------------------------ */
router.post("/attach-callsid", bodyParser.json(), async (req, res) => {
    try {
        const { id, callSid } = req.body;
        if (!id || !callSid) return res.status(400).json({ error: "id and callSid required" });

        // Find lead phone by LeadID
        const [leadRows] = await con.query(`SELECT Phone, DialedBy FROM DialingData WHERE LeadID = ? LIMIT 1`, [id]);
        if (!leadRows || leadRows.length === 0) return res.status(404).json({ error: "Lead not found" });

        const phone = normalizePhone(leadRows[0].Phone || "");
        const dialedBy = String(leadRows[0].DialedBy || req.user?.ID || "agent");

        // Try to find a recent CallLog for this phone with empty CallSID
        const [logs] = await con.query(
            `SELECT ID FROM CallLogs WHERE Phone = ? AND (CallSID IS NULL OR CallSID = '') ORDER BY ID DESC LIMIT 1`,
            [phone]
        );

        if (logs && logs.length) {
            // Update the most recent CallLog's CallSID
            await con.query(`UPDATE CallLogs SET CallSID = ? WHERE ID = ?`, [callSid, logs[0].ID]);
        } else {
            // Insert a new CallLog with CallSID
            await insertCallLog(phone, "dialing", dialedBy, callSid, null, null);
        }

        return res.json({ success: true });
    } catch (err) {
        console.error("attach-callsid error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ---------------- POST /end ----------------
   Agent final disposition:
   - Update DialingData.Status = disposition (ONLY Status)
   - Insert/Update CallLogs with CallSID, Duration, RecordingUrl, and disposition
------------------------------------------------------------------ */
router.post("/end", bodyParser.json(), async (req, res) => {
    try {
        const { callSid, leadID, disposition, duration, recordingUrl, phone } = req.body;
        const empID = String(req.user?.ID || "agent");
        if (!disposition) return res.status(400).json({ error: "disposition required" });

        // Normalize phone for call-log
        const phoneForLog = normalizePhone(phone || "");

        // 1) Update DialingData -> ONLY Status
        if (leadID) {
            await con.query(`UPDATE DialingData SET Status = ? WHERE LeadID = ?`, [disposition, leadID]);
        } else if (phoneForLog) {
            // fallback: update by phone (best-effort)
            await con.query(
                `UPDATE DialingData SET Status = ? WHERE REPLACE(REPLACE(REPLACE(Phone, ' ', ''), '-', ''), '+', '') LIKE ? ORDER BY LeadID DESC LIMIT 1`,
                [disposition, `%${phoneForLog}%`]
            );
        }

        // 2) Insert or update CallLogs with user-provided metadata (CallSID, duration, recordingUrl)
        await insertCallLog(phoneForLog, disposition, empID, callSid || null, duration != null ? Number(duration) : null, recordingUrl || null);

        return res.json({ success: true });
    } catch (err) {
        console.error("POST /end error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ---------------- check-status ----------------
   Check DialingData.Status by CallSID
------------------------------------------------------------------ */
router.get("/check-status", async (req, res) => {
    try {
        const { callSid } = req.query;
        if (!callSid) return res.status(400).json({ error: "callSid required" });

        const [rows] = await con.query(`SELECT Status FROM DialingData WHERE CallSID = ? LIMIT 1`, [callSid]);
        if (!rows || rows.length === 0) return res.status(404).json({ status: "unknown" });

        res.json({ status: String(rows[0].Status || "").toLowerCase() });
    } catch (err) {
        console.error("GET /check-status error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ---------------- fetch lead ---------------- */

router.get("/lead/:leadID", async (req, res) => {
    try {
        const { leadID } = req.params;
        const [rows] = await con.query(`SELECT * FROM DialingData WHERE LeadID = ? LIMIT 1`, [leadID]);
        if (!rows || rows.length === 0) return res.status(404).json({ error: "Lead not found" });

        res.json({ success: true, row: rows[0] });
    } catch (err) {
        console.error("GET /lead/:id error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;