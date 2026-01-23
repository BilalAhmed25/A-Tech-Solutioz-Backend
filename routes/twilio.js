require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const VoiceResponse = Twilio.twiml.VoiceResponse;

const { BASE_URL_FOR_TWILIO_CALLBACKS, TWILIO_NUMBER, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- HELPER: Insert Log ---
const insertCallLog = async (phone, status, dialedBy, callSid, duration = 0, recordingUrl = null) => {
    try {
        await con.query(
            `INSERT INTO CallLogs (Phone, CallSID, Status, DialedBy, Duration, RecordingUrl) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE Status = VALUES(Status)`, // Safety: update if exists
            [phone, callSid, status, dialedBy, Number(duration), recordingUrl]
        );
    } catch (err) {
        console.error("DB Insert Error:", err);
    }
};

// --- HELPER: Update Status (Safe Update) ---
const updateCallStatus = async (callSid, status, isFinal = false) => {
    try {
        // Logic: Always update if we have a specific status (Busy, Voicemail, Hangup, etc.)
        // If the new status is generic like "Completed", ONLY update if the current DB status is "Dialing", "Ringing" or "Answered".
        // We do NOT want "Completed" to overwrite "Voicemail" or "Busy".

        let query = `UPDATE CallLogs SET Status = ? WHERE CallSID = ?`;

        if (status === 'Completed') {
            // Protect specific statuses from being overwritten by a generic 'Completed' event
            query += ` AND Status NOT IN ('Busy', 'Voicemail', 'Number not in service', 'Hangup', 'No answer')`;
        }

        await con.query(query, [status, callSid]);

        // Update secondary table if it exists
        try {
            await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [status, callSid]);
        } catch (e) { /* ignore if table doesn't exist */ }

    } catch (err) {
        console.error(`DB Update Error (${status}):`, err);
    }
};

// ==========================================
// 1. VOICE HANDLER (Call Start)
// ==========================================
router.post("/voice-handler", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { To, userID, CallSid } = req.body;
    const response = new VoiceResponse();

    if (!To) {
        response.say("Invalid number provided.");
        return res.type("text/xml").send(response.toString());
    }

    // 1. LOG IMMEDIATELY
    await insertCallLog(To, "Dialing", userID, CallSid);

    try {
        // 2. SETUP TRANSCRIPTION (Optional - kept from your code)
        const start = response.start();
        if (process.env.TWILIO_INTELLIGENCE_SERVICE_SID) {
            start.transcription({
                statusCallbackUrl: `${BASE_URL_FOR_TWILIO_CALLBACKS}/transcription-callback?userID=${userID}`,
                transcriptionEngine: 'google',
                track: 'both_tracks',
                languageCode: 'en-US',
                partialResults: true,
                enableAutomaticPunctuation: true,
                intelligenceService: process.env.TWILIO_INTELLIGENCE_SERVICE_SID,
            });
        }

        // 3. DIAL with AMD (Answering Machine Detection)
        const dial = response.dial({
            callerId: TWILIO_NUMBER,
            timeout: 20, // slightly increased for mobile latency
            record: 'record-from-answer',
            recordingStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/recording-status`,
            // Action handles what happens AFTER the call connects or fails
            action: `${BASE_URL_FOR_TWILIO_CALLBACKS}/dial-action?parentSid=${CallSid}`,
            // StatusCallback handles async events (ringing, canceled, completed)
            statusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/dial-status?parentSid=${CallSid}&userID=${userID}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'canceled']
        });

        dial.number({
            machineDetection: 'Enable',
            machineDetectionTimeout: 30,
            // Async AMD result
            amdStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/amd-status?parentSid=${CallSid}&userID=${userID}`,
            amdStatusCallbackMethod: 'POST'
        }, To);

        res.type("text/xml").send(response.toString());

    } catch (error) {
        console.error("Voice Handler Error:", error);
        await updateCallStatus(CallSid, "Failed");
        const failResponse = new VoiceResponse();
        failResponse.say("We are unable to process your call.");
        return res.status(200).type("text/xml").send(failResponse.toString());
    }
});

// ==========================================
// 2. AMD STATUS (Machine Detection)
// ==========================================
router.post("/amd-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { parentSid, userID } = req.query;
    const { AnsweredBy } = req.body;

    console.log(`AMD Detected: ${AnsweredBy} for Call ${parentSid}`);

    if (AnsweredBy === "machine_start" || AnsweredBy === "machine_end_beep" || AnsweredBy === "machine_end_silence" || AnsweredBy === "fax") {

        const status = (AnsweredBy === "fax") ? "Number not in service" : "Voicemail";

        // 1. Update DB
        await updateCallStatus(parentSid, status);

        // 2. Notify Frontend (Socket)
        if (global.io) {
            global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", { status: status, callSid: parentSid });
        }

        // 3. Kill the call immediately
        try {
            await client.calls(parentSid).update({ status: "completed" });
        } catch (e) { console.error("Could not hangup parent call", e.message); }
    } else if (AnsweredBy === "human") {
        // If human, we mark it as Answered. The User will provide final status.
        await updateCallStatus(parentSid, "Answered");
    }

    res.sendStatus(200);
});

// ==========================================
// 3. DIAL ACTION (Post-Call Logic)
// ==========================================
// This runs when the Dial ends (e.g., Busy, No Answer, or Call Finished)
router.post("/dial-action", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    // 1. Grab DialCallDuration from the body
    const { DialCallStatus, DialCallDuration } = req.body;
    const { parentSid } = req.query;

    console.log(`Dial Action: ${DialCallStatus} | Duration: ${DialCallDuration} | SID: ${parentSid}`);

    let finalStatus = null;
    const duration = parseInt(DialCallDuration || '0', 10);

    // 2. Logic to detect instant disconnects
    if (DialCallStatus === "busy") {
        finalStatus = "Busy";
    }
    else if (DialCallStatus === "no-answer") {
        finalStatus = "No answer";
    }
    else if (DialCallStatus === "failed") {
        finalStatus = "Number not in service";
    }
    else if (DialCallStatus === "canceled") {
        finalStatus = "Hangup";
    }
    // FIX: If "completed" but duration is <= 1 second, it's a Hangup (Instant drop)
    else if (DialCallStatus === "completed" && duration <= 1) {
        finalStatus = "Hangup";
    }

    // 3. Force Update if we found a status
    if (finalStatus) {
        await updateCallStatus(parentSid, finalStatus);
    }

    const response = new VoiceResponse();
    response.hangup();
    res.type("text/xml").send(response.toString());
});

router.post("/dial-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallStatus, ErrorCode, CallDuration } = req.body;
    const { parentSid, userID } = req.query;

    console.log(`Dial Status: ${CallStatus} | Dur: ${CallDuration} | SID: ${parentSid}`);

    let dbStatus = null;
    const duration = parseInt(CallDuration || '0', 10);

    const invalidCodes = ['13223', '13224', '21214', '21217', '30005'];

    if (invalidCodes.includes(ErrorCode)) {
        dbStatus = "Invalid Number";
    }
    else {
        switch (CallStatus) {
            case "canceled":
                dbStatus = "Hangup";
                break;
            case "busy":
                dbStatus = "Busy";
                break;
            case "no-answer":
                dbStatus = "No answer";
                break;
            case "failed":
                dbStatus = "Number not in service";
                break;
            case "completed":
                // FIX: Treat 0 or 1 second duration as Hangup
                if (duration <= 1) {
                    dbStatus = "Hangup";
                } else {
                    // For longer calls, we can set "Call Ended" or leave it "Answered"
                    // depending on if you want the agent to manually dispose it.
                    // For now, "Completed" ensures the log isn't empty.
                    dbStatus = "Completed";
                }
                break;
            case "answered":
            case "in-progress":
                dbStatus = "Answered";
                break;
        }
    }

    if (dbStatus) {
        await updateCallStatus(parentSid, dbStatus);

        // Notify frontend if it's a terminal status
        if (global.io && ["Busy", "No answer", "Number not in service", "Invalid Number", "Hangup", "Voicemail"].includes(dbStatus)) {
            global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", {
                status: dbStatus,
                callSid: parentSid
            });
        }
    }

    res.sendStatus(200);
});

// ==========================================
// 5. OTHER HANDLERS (Recording, Transcript)
// ==========================================

router.post("/recording-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, RecordingUrl, RecordingSid, RecordingDuration, RecordingStatus } = req.body;

    // Note: CallSid here might be the Child SID. Usually, we want to update based on Parent SID.
    // However, if you store the Parent SID in the DB, ensure this matches.
    // Twilio Dual Channel recording usually tags the Parent Call.

    if (RecordingStatus === 'completed' && RecordingUrl) {
        try {
            await con.query(
                `UPDATE CallLogs SET RecordingUrl = ?, RecordingSid = ?, Duration = ? WHERE CallSID = ?`,
                [RecordingUrl, RecordingSid, RecordingDuration, CallSid]
            );
        } catch (err) {
            console.error("Recording Log Error:", err);
        }
    }
    res.sendStatus(200);
});

router.post("/transcription-callback", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { TranscriptionEvent, CallSid, TranscriptionData } = req.body;
    const userID = req.query.userID;

    if (TranscriptionEvent === 'transcription-summary') {
        const data = JSON.parse(TranscriptionData);
        try {
            await con.query(`UPDATE CallLogs SET AISummary = ? WHERE CallSID = ?`, [data.summary, CallSid]);
            if (global.io) {
                global.io.to(`agent:${userID}`).emit("call-summary-ready", { callSid: CallSid, summary: data.summary });
            }
        } catch (err) { console.error("Summary Log Error:", err); }
    }
    res.sendStatus(200);
});

module.exports = router;