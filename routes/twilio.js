require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const VoiceResponse = Twilio.twiml.VoiceResponse;
const AccessToken = Twilio.jwt.AccessToken;

const { BASE_URL_FOR_TWILIO_CALLBACKS, TWILIO_NUMBER } = process.env;

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

router.post("/voice-handler", bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { To } = req.body;
    const response = new VoiceResponse();

    if (!To) {
        response.say("Invalid number provided.");
        return res.type("text/xml").send(response.toString());
    }

    const dial = response.dial({
        callerId: TWILIO_NUMBER,
        answerOnBridge: true,
        statusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/call-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'failed', 'busy', 'no-answer', 'canceled'],
        statusCallbackMethod: 'POST'
    });
    dial.number(To);

    res.type("text/xml").send(response.toString());
});

/* ---------------- Twilio status webhook ----------------
   - Always insert/update CallLogs with CallSID, RecordingUrl, Duration, Status
   - Update DialingData but ONLY Status (no other columns)
------------------------------------------------------------------ */
router.post("/call-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const {
        CallSid,         // Twilio uses CallSid (case variations exist)
        CallSID,         // handle both
        CallStatus,
        To,
        From,
        CallDuration,
        RecordingUrl
    } = req.body;

    const callSid = CallSid || CallSID || null;
    const status = String(CallStatus || "").toLowerCase();
    const phoneRaw = To || From || "";
    const phoneNormalized = normalizePhone(phoneRaw);

    try {
        // 1) Insert/update CallLogs (CallSID, status, duration, recordingUrl) — idempotent by CallSID
        await insertCallLog(phoneNormalized, status, "Twilio", callSid, CallDuration ? Number(CallDuration) : null, RecordingUrl || null);

        // 2) Update DialingData -> only Status column
        // Find matching lead by CallSID first, fallback to last matching phone
        let lead = null;
        if (callSid) {
            const [r] = await con.query(`SELECT LeadID FROM DialingData WHERE CallSID = ? LIMIT 1`, [callSid]);
            if (r && r.length) lead = r[0];
        }

        if (!lead && phoneNormalized) {
            const [r2] = await con.query(
                `SELECT LeadID FROM DialingData WHERE REPLACE(REPLACE(REPLACE(Phone, ' ', ''), '-', ''), '+', '') LIKE ? ORDER BY LeadID DESC LIMIT 1`,
                [`%${phoneNormalized}%`]
            );
            if (r2 && r2.length) lead = r2[0];
        }

        if (lead && typeof status === "string") {
            // IMPORTANT: Only update the Status column — nothing else on DialingData.
            await con.query(`UPDATE DialingData SET Status = ? WHERE LeadID = ?`, [status, lead.LeadID]);
        }
    } catch (err) {
        console.error("Error in call-status webhook:", err);
    }

    // Reply quickly to Twilio
    res.sendStatus(200);
});

module.exports = router;