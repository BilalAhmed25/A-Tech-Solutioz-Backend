require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const VoiceResponse = Twilio.twiml.VoiceResponse;
const AccessToken = Twilio.jwt.AccessToken;

const { BASE_URL_FOR_TWILIO_CALLBACKS, TWILIO_NUMBER } = process.env;

const insertCallLog = async (phone = "", status = "", dialedBy = "", callSid = null, duration = null, recordingUrl = null) => {
    try {
        await con.query(
            `INSERT INTO CallLogs (Phone, CallSID, Status, DialedBy, Duration, RecordingUrl) VALUES (?, ?, ?, ?, ?, ?)`,
            [phone || "", callSid || '', status || "", dialedBy || "", duration != null ? Number(duration) : '', recordingUrl || '']
        );
    } catch (err) {
        console.error("An error occurred while inserting call log:", err);
    }
};

router.post("/voice-handler", bodyParser.urlencoded({ extended: false }), (req, res) => {
    const { To, agentId } = req.body;
    const response = new VoiceResponse();

    if (!To) {
        response.say("Invalid number provided.");
        return res.type("text/xml").send(response.toString());
    }

    const dial = response.dial({
        callerId: TWILIO_NUMBER,
        // answerOnBridge: true,
        statusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/call-status?dialedBy=${agentId || 'System'}`,
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
    const { CallSid, CallSID, CallStatus, To, From, CallDuration, RecordingUrl, Direction } = req.body;
    const dialedByFromUrl = req.query.dialedBy;
    const callSid = CallSid || CallSID || null;
    const status = String(CallStatus || "").toLowerCase();

    try {
        if (Direction === 'outbound-dial') {
            await insertCallLog(To, status, dialedByFromUrl, callSid, CallDuration ? Number(CallDuration) : null, RecordingUrl || null);
        }
    } catch (err) {
        console.error("Error in call-status webhook:", err);
    }
    // Reply quickly to Twilio
    res.sendStatus(200);
});

/* ---------------- Fetch Twilio Call Logs ----------------
   GET /twilio-call-logs?limit=20&from=+15632588523&to=+1234567890&status=completed
--------------------------------------------------------- */
router.get("/twilio-call-logs", async (req, res) => {
    try {
        const TwilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        const limit = Number(req.query.limit) || 20;
        const from = req.query.from || undefined;
        const to = req.query.to || undefined;
        const status = req.query.status || undefined;

        const filters = { limit };
        if (from) filters.from = from;
        if (to) filters.to = to;
        if (status) filters.status = status;

        const calls = await TwilioClient.calls.list(filters);

        // Map to simpler JSON format
        const callLogs = calls.map(c => ({
            sid: c.sid,
            from: c.from,
            to: c.to,
            status: c.status,
            startTime: c.startTime,
            endTime: c.endTime,
            duration: c.duration,
            price: c.price,
            direction: c.direction,
            errorCode: c.errorCode,
            errorMessage: c.errorMessage,
            recordingSid: c.subresourceUris.recordings
        }));

        res.json({ success: true, data: callLogs });
    } catch (err) {
        res.status(500).json({ success: false, error: "Failed to fetch Twilio call logs" });
    }
});

module.exports = router;