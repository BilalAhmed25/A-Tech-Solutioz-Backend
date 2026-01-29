require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const telnyx = require("telnyx")(process.env.TELNYX_API_KEY);
const { con } = require("../database");

const router = express.Router();
const moment = require("moment-timezone");

const { BASE_URL_FOR_TELNYX_CALLBACKS, TELNYX_NUMBER } = process.env;

// --- Helper for generating TeXML (Telnyx XML) without Twilio SDK ---
class TeXMLResponse {
    constructor() {
        this.response = [];
    }
    say(text) {
        this.response.push(`<Say>${text}</Say>`);
    }
    dial(options = {}) {
        const attributes = [];
        if (options.callerId) attributes.push(`callerId="${options.callerId}"`);
        if (options.timeout) attributes.push(`timeout="${options.timeout}"`);
        if (options.record) attributes.push(`record="${options.record}"`);
        if (options.recordingStatusCallback) attributes.push(`recordingStatusCallback="${options.recordingStatusCallback}"`);
        if (options.action) attributes.push(`action="${options.action}"`);
        if (options.method) attributes.push(`method="${options.method}"`);

        // Add Status Callback events
        if (options.statusCallback) attributes.push(`statusCallback="${options.statusCallback}"`);
        if (options.statusCallbackMethod) attributes.push(`statusCallbackMethod="${options.statusCallbackMethod}"`);
        if (options.statusCallbackEvent) {
            // Telnyx accepts space-separated events
            attributes.push(`statusCallbackEvent="${options.statusCallbackEvent.join(' ')}"`);
        }

        const dialTag = { text: `<Dial ${attributes.join(" ")}>`, end: "</Dial>", content: [] };
        this.response.push(dialTag);

        return {
            number: (to, numOptions = {}) => {
                const numAttrs = [];
                if (numOptions.amdStatusCallback) numAttrs.push(`amdStatusCallback="${numOptions.amdStatusCallback}"`);
                if (numOptions.amdStatusCallbackMethod) numAttrs.push(`amdStatusCallbackMethod="${numOptions.amdStatusCallbackMethod}"`);

                // Map machine detection to Telnyx values if needed, or pass through
                if (numOptions.machineDetection) numAttrs.push(`machineDetection="${numOptions.machineDetection}"`);

                dialTag.content.push(`<Number ${numAttrs.join(" ")}>${to}</Number>`);
            }
        };
    }
    start() {
        // Simple start tag placeholder for transcription
        const startTag = { text: "<Start>", end: "</Start>", content: [] };
        this.response.push(startTag);
        return {
            transcription: (options = {}) => {
                const attrs = [];
                if (options.statusCallbackUrl) attrs.push(`statusCallbackUrl="${options.statusCallbackUrl}"`);
                if (options.track) attrs.push(`track="${options.track}"`);
                startTag.content.push(`<Transcription ${attrs.join(" ")} />`);
            }
        };
    }
    toString() {
        const build = (items) => items.map(i => {
            if (typeof i === 'string') return i;
            return `${i.text}${i.content.join('')}${i.end}`;
        }).join('');
        return `<?xml version="1.0" encoding="UTF-8"?><Response>${build(this.response)}</Response>`;
    }
}

// --- Insert call log ---
const insertCallLog = async (phone, status, dialedBy, callSid, duration = 0, recordingUrl = null) => {
    try {
        const nowUTC = moment.utc().format("YYYY-MM-DD HH:mm:ss");
        await con.query(
            `INSERT INTO CallLogs (Phone, CallSID, Status, DialedBy, DialedOn, Duration, RecordingUrl) VALUES (?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE Status = VALUES(Status)`,
            [phone, callSid, status, dialedBy, nowUTC, Number(duration), recordingUrl]
        );
    } catch (err) {
        console.error("DB Insert Error:", err);
    }
};

// --- Update call status safely ---
const updateCallStatus = async (callSid, status) => {
    try {
        let query = `UPDATE CallLogs SET Status = ? WHERE CallSID = ?`;
        const params = [status, callSid];
        try {
            await con.query(query, params);
            await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [status, callSid]);
        } catch (e) { }
    } catch (err) {
        console.error(`DB Update Error (${status}):`, err);
    }
};

// 1. VOICE HANDLER
router.post("/voice-handler", async (req, res) => {
    const { To, userID, CallSid } = req.body;
    const response = new TeXMLResponse();

    // 1. Validation
    const e164Regex = /^\+[1-9]\d{7,14}$/;
    if (!To || !e164Regex.test(To)) {
        await insertCallLog(To, "Invalid number", userID, CallSid);
        const r = new TeXMLResponse();
        r.say("Invalid phone number is dialed.");
        return res.type("text/xml").send(r.toString());
    }

    try {
        await insertCallLog(To, "No answer", userID, CallSid);

        // 2. Transcription
        const start = response.start();
        start.transcription({
            statusCallbackUrl: `${BASE_URL_FOR_TELNYX_CALLBACKS}/transcription-callback?userID=${userID}`,
            track: 'both_tracks'
        });

        // 3. Dialing Logic
        const dial = response.dial({
            callerId: TELNYX_NUMBER,
            timeout: 20,
            record: 'record-from-answer',
            recordingStatusCallback: `${BASE_URL_FOR_TELNYX_CALLBACKS}/recording-status`,
            statusCallback: `${BASE_URL_FOR_TELNYX_CALLBACKS}/dial-status?parentSid=${CallSid}&userID=${userID}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        // 4. AMD Setup (Telnyx specific)
        dial.number(To, {
            machineDetection: 'detect_message_end',
            amdStatusCallback: `${BASE_URL_FOR_TELNYX_CALLBACKS}/amd-status?parentSid=${CallSid}&userID=${userID}`,
            amdStatusCallbackMethod: 'POST'
        });

        res.type("text/xml").send(response.toString());

    } catch (err) {
        console.error("Telnyx Voice Handler Error:", err);
        await insertCallLog(To, "Failed", userID, CallSid);
        const failResponse = new TeXMLResponse();
        failResponse.say("We are unable to process your call.");
        return res.status(200).type("text/xml").send(failResponse.toString());
    }
});

// 2. AMD STATUS (Machine Detection)
router.post("/amd-status", async (req, res) => {
    const { parentSid, userID } = req.query;
    // Telnyx sends the result in the 'result' field usually, but for TeXML compatibility it might map to AnsweredBy. 
    // Checking both for safety.
    const AnsweredBy = req.body.AnsweredBy || req.body.result;

    if (["machine_start", "machine_end_beep", "machine_end_silence", "fax"].includes(AnsweredBy)) {
        const status = (AnsweredBy === "fax") ? "Number not in service" : "Voicemail";

        await updateCallStatus(parentSid, status);

        if (global.io) {
            global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", { status, callSid: parentSid });
        }

        try {
            // Telnyx TeXML Call Hangup
            // We use the Telnyx SDK to update the call status
            // Note: Ensure parentSid is the valid Call Control ID or Call Session ID
            await telnyx.calls.update(parentSid, { status: "completed" });
        } catch (e) { console.error("Could not hangup parent call", e.message); }

    } else if (AnsweredBy === "human") {
        await updateCallStatus(parentSid, "Answered");
        if (global.io) {
            global.io.to(`agent:${userID}`).emit("call-answered", { callSid: parentSid });
        }
    }

    res.sendStatus(200);
});

// 3. DIAL STATUS
router.post("/dial-status", async (req, res) => {
    const { CallStatus, CallDuration, ErrorCode, CallSid } = req.body;
    let { parentSid, userID } = req.query;

    parentSid = parentSid || CallSid;
    if (!parentSid) {
        console.warn("Missing parentSid in dial-status webhook", req.body);
        return res.sendStatus(400);
    }

    userID = userID || "unknown";

    const duration = parseInt(CallDuration || '0', 10);

    // Standardizing Statuses
    let finalStatus = "Failed";

    // Telnyx might send different error codes, but basic CallStatus mapping:
    if (CallStatus) {
        switch (CallStatus.toLowerCase()) {
            case "failed":
                finalStatus = "Number not in service";
                break;
            case "canceled":
                finalStatus = duration <= 2 ? "Hangup" : "Canceled";
                break;
            case "busy":
                finalStatus = "Busy";
                break;
            case "no-answer":
                finalStatus = "No answer";
                break;
            case "completed":
                finalStatus = duration <= 2 ? "Hangup" : "Completed";
                break;
            case "answered":
            case "in-progress":
                finalStatus = "Answered";
                break;
            default:
                finalStatus = "Failed";
        }
    }

    await updateCallStatus(parentSid, finalStatus);

    if (global.io) {
        global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", { status: finalStatus, callSid: parentSid });
    }

    console.log("Dial-status processed:", { parentSid, userID, finalStatus });
    res.sendStatus(200);
});

// 4. TRANSCRIPTION CALLBACK
router.post("/transcription-callback", (req, res) => {
    // Telnyx transcription body parsing
    // Telnyx typically sends JSON in the body for transcriptions
    const payload = req.body;

    // Adjust based on actual Telnyx Webhook structure for TeXML transcription
    const transcriptText = payload.transcription_text || payload.TranscriptionText;
    const callSid = payload.call_control_id || payload.CallSid;
    const userID = req.query.userID;

    if (!transcriptText || !callSid || !userID) return res.sendStatus(200);

    global.io.to(`agent:${userID}`).emit("transcript", {
        track: 'inbound', // Telnyx usually mixes or separates, logic may vary
        transcript: transcriptText,
        final: true,
        callSid
    });

    res.sendStatus(200);
});

// 5. RECORDING STATUS
router.post("/recording-status", async (req, res) => {
    const { CallSid, RecordingUrl, RecordingSid, RecordingStatus, RecordingDuration } = req.body;

    // Telnyx sends 'completed' or 'available'
    if ((RecordingStatus === 'completed' || RecordingStatus === 'available') && RecordingUrl) {
        try {
            await con.query(
                `UPDATE CallLogs SET RecordingUrl = ?, RecordingSid = ?, Duration = ? WHERE CallSID = ?`,
                [RecordingUrl, RecordingSid, RecordingDuration, CallSid]
            );
            res.sendStatus(200);
        } catch (err) {
            res.sendStatus(500);
            console.error("Error updating recording URL:", err);
        }
    }
});

// 6. BALANCE
router.get("/balance", async (req, res) => {
    try {
        const balance = await telnyx.balance.retrieve();
        return res.status(200).json({
            balance: Number(balance.balance),
            currency: balance.currency,
            accountSid: "TELNYX_ACCOUNT"
        });
    } catch (error) {
        return res.status(500).json("Unable to fetch Telnyx balance");
    }
});

module.exports = router;