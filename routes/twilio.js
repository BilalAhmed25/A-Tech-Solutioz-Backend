require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const VoiceResponse = Twilio.twiml.VoiceResponse;

const { BASE_URL_FOR_TWILIO_CALLBACKS, TWILIO_NUMBER, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const moment = require("moment-timezone");
const nowPKT = moment.tz("Asia/Karachi").format("YYYY-MM-DD HH:mm:ss");

// --- Insert call log ---
const insertCallLog = async (phone, status, dialedBy, callSid, duration = 0, recordingUrl = null) => {
    try {
        await con.query(
            `INSERT INTO CallLogs (Phone, CallSID, Status, DialedBy, DialedOn, Duration, RecordingUrl) VALUES (?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE Status = VALUES(Status)`,
            [phone, callSid, status, dialedBy, nowPKT, Number(duration), recordingUrl]
        );
    } catch (err) {
        console.error("DB Insert Error:", err);
    }
};

// --- Update call status safely ---
const updateCallStatus = async (callSid, status, duration = null) => {
    try {
        let query = `UPDATE CallLogs SET Status = ?`;
        const params = [status];

        if (duration !== null) {
            query += `, Duration = ?`;
            params.push(duration);
        }

        query += ` WHERE CallSID = ?`;
        params.push(callSid);

        await con.query(query, params);

        // Optional: update secondary table if exists
        try {
            await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [status, callSid]);
        } catch (e) { }
    } catch (err) {
        console.error(`DB Update Error (${status}):`, err);
    }
};

// 1. VOICE HANDLER
router.post("/voice-handler", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { To, userID, CallSid } = req.body;
    const response = new VoiceResponse();

    const e164Regex = /^\+[1-9]\d{7,14}$/;
    if (!To || !e164Regex.test(To)) {
        await insertCallLog(To, "Invalid number", userID, CallSid);
        const r = new VoiceResponse();
        r.say("Invalid phone number is dialed.");
        return res.type("text/xml").send(r.toString());
    }

    // Insert initial log
    await insertCallLog(To, "Dialing", userID, CallSid);

    try {
        // Real-time transcription
        const start = response.start();
        start.transcription({
            statusCallbackUrl: `${BASE_URL_FOR_TWILIO_CALLBACKS}/transcription-callback?userID=${userID}`,
            transcriptionEngine: 'google',
            track: 'both_tracks',
            languageCode: 'en-US',
            partialResults: true,
            enableAutomaticPunctuation: true,
        });

        const dial = response.dial({
            callerId: TWILIO_NUMBER,
            timeout: 20, // Call will ring for 20s
            record: 'record-from-answer',
            statusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/dial-status?parentSid=${CallSid}&userID=${userID}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'canceled', 'failed']
        });

        // Dial the number with AMD
        dial.number({
            machineDetection: 'Enable',
            machineDetectionTimeout: 30,
            amdStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/amd-status?parentSid=${CallSid}&userID=${userID}`,
            amdStatusCallbackMethod: 'POST'
        }, To);

        res.type("text/xml").send(response.toString());
    } catch (err) {
        await updateCallStatus(CallSid, "Failed");
        const failResponse = new VoiceResponse();
        failResponse.say("We are unable to process your call.");
        return res.status(200).type("text/xml").send(failResponse.toString());
    }
});

// 2. AMD STATUS (Machine Detection)
router.post("/amd-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { parentSid, userID } = req.query;
    const { AnsweredBy } = req.body;
    if (["machine_start", "machine_end_beep", "machine_end_silence", "fax"].includes(AnsweredBy)) {
        const status = (AnsweredBy === "fax") ? "Number not in service" : "Voicemail";

        await updateCallStatus(parentSid, status);

        if (global.io) {
            global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", { status, callSid: parentSid });
        }

        try {
            await client.calls(parentSid).update({ status: "completed" });
        } catch (e) { console.error("Could not hangup parent call", e.message); }

    } else if (AnsweredBy === "human") {
        // Human answered — mark as Answered, wait for frontend if >2s
        await updateCallStatus(parentSid, "Answered");
    }

    res.sendStatus(200);
});

// 3. DIAL STATUS
router.post("/dial-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallStatus, CallDuration, ErrorCode, CallSid } = req.body;
    let { parentSid, userID } = req.query;
    // fallback if query params are missing
    parentSid = parentSid || CallSid;
    if (!parentSid) {
        console.warn("Missing parentSid/CallSid in dial-status webhook", req.body, req.query);
        return res.sendStatus(400);
    }

    userID = userID || "unknown"; // fallback, prevent crash

    const duration = parseInt(CallDuration || '0', 10);

    const errorCodeMap = {
        '21210': 'Invalid Number',
        '21401': 'Invalid Number',
        '13223': 'Invalid Number',
        '13224': 'Invalid Number',
        '21211': 'Invalid Number',
        '21212': 'Number not in service',
        '21214': 'Number not in service',
        '21217': 'Number not in service',
        '30005': 'Number not in service'
    };

    let finalStatus = "Failed"; // default fallback

    if (ErrorCode && errorCodeMap[ErrorCode]) {
        finalStatus = errorCodeMap[ErrorCode];
    } else if (CallStatus) {
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

    // Always update DB
    await updateCallStatus(parentSid, finalStatus, duration);

    // Always emit status to frontend
    if (global.io) {
        global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", { status: finalStatus, callSid: parentSid });
    }

    console.log("Dial-status processed:", { parentSid, userID, finalStatus, CallStatus, ErrorCode, CallSid });

    res.sendStatus(200);
});

router.post("/transcription-callback", bodyParser.urlencoded({ extended: false }), (req, res) => {
    const event = req.body.TranscriptionEvent;

    if (event !== "transcription-content") {
        return res.sendStatus(200);
    }

    const transcriptData = req.body.TranscriptionData
        ? JSON.parse(req.body.TranscriptionData)
        : null;

    if (!transcriptData) return res.sendStatus(200);

    const callSid = req.body.CallSid;
    const userID = req.query.userID;

    const track = req.body.Track || 'inbound_track';
    const final = req.body.Final === "true";
    const transcript = transcriptData.transcript;

    if (!callSid || !userID) return res.sendStatus(200);

    global.io.to(`agent:${userID}`).emit("transcript", {
        track,
        transcript,
        final,
        callSid
    });

    res.sendStatus(200);
});

router.get("/balance", async (req, res) => {
    try {
        const balance = await client.balance.fetch();
        return res.status(200).json({
            balance: Number(balance.balance),
            currency: balance.currency,
            accountSid: balance.accountSid
        });

    } catch (error) {
        return res.status(500).json("Unable to fetch Twilio balance");
    }
});


module.exports = router;
