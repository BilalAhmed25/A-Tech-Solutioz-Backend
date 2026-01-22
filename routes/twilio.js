require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const Twilio = require("twilio");
const { con } = require("../database");

const router = express.Router();
const VoiceResponse = Twilio.twiml.VoiceResponse;

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
    const { To, userID } = req.body;
    const parentCallSid = req.body.CallSid;
    const response = new VoiceResponse();

    if (!To) {
        response.say("Invalid number provided.");
        return res.type("text/xml").send(response.toString());
    }

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

            intelligenceService: process.env.TWILIO_INTELLIGENCE_SERVICE_SID,
        });

        const dial = response.dial({
            callerId: TWILIO_NUMBER,
            action: `${BASE_URL_FOR_TWILIO_CALLBACKS}/dial-action?parentSid=${parentCallSid}`,
            timeout: 16,
            record: 'record-from-answer',
            recordingStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/recording-status`,
            // answerOnBridge: true,

            statusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/dial-status?parentSid=${parentCallSid}&userID=${userID}&phone=${To}`,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['completed']
        });

        // dial.number(To);
        dial.number({
            machineDetection: 'Enable', // Activates detection
            amdStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/amd-status?parentSid=${parentCallSid}&userID=${userID}&phone=${To}`,
        }, To);
        res.type("text/xml").send(response.toString());
    } catch (error) {
        console.error(error);
        const failResponse = new VoiceResponse();
        failResponse.say("We are unable to process your call right now. Please try again.");
        return res.status(200).type("text/xml").send(failResponse.toString());
    }
});

router.post("/dial-action", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { DialCallStatus } = req.body;
    const { parentSid } = req.query; // This is the SID in your CallLogs table

    let finalStatus = "Voicemail";
    if (DialCallStatus === "no-answer") finalStatus = "No answer";
    if (DialCallStatus === "busy") finalStatus = "Busy";
    if (DialCallStatus === "failed") finalStatus = "Number not in service";

    try {
        // Force the update here because we know this is a specific event
        await con.query(`UPDATE CallLogs SET Status = ? WHERE CallSID = ?`, [finalStatus, parentSid]);
    } catch (err) {
        console.error("Dial Action Error:", err);
    }

    const response = new Twilio.twiml.VoiceResponse();
    response.hangup();
    res.type("text/xml").send(response.toString());
});

router.post("/amd-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { parentSid } = req.query;
    const { AnsweredBy } = req.body;

    if (AnsweredBy !== "human") {
        const reportStatus = AnsweredBy === "fax" ? "Number not in service" : "Voicemail";

        try {
            await con.query(`UPDATE CallLogs SET Status = ? WHERE CallSID = ?;`, [reportStatus, parentSid]);
            await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?;`, [reportStatus, parentSid]);

            // 1. TELL FRONTEND TO DISCONNECT FIRST
            // if (global.io) {
            //     global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", {
            //         status: reportStatus,
            //         callSid: parentSid
            //     });
            // }

            // 2. HANG UP TWILIO CALL
            const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            // We terminate the Parent call to ensure both ends drop immediately
            await twilioClient.calls(parentSid).update({ status: "completed" });

        } catch (err) {
            console.error("AMD Mapping Error:", err);
        }
    }
    res.status(200).send("OK");
});

router.post("/dial-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallStatus, CallSid } = req.body;
    const { parentSid, userID, phone } = req.query;

    let finalStatus = null;

    switch (CallStatus) {
        case "busy":
            finalStatus = "Busy";
            break;

        case "no-answer":
            finalStatus = "No answer";
            break;

        case "failed":
            finalStatus = "Number not in service";
            break;

        case "canceled":
            finalStatus = "Canceled";
            break;

        default:
            return res.sendStatus(200); // Ignore ringing/initiated/answered
    }

    try {
        // Update DB
        await con.query(`UPDATE CallLogs SET Status = ? WHERE CallSID = ?;`, [finalStatus, parentSid]);
        await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [finalStatus, parentSid]);

        // Notify frontend (same as AMD flow)
        if (global.io) {
            global.io.to(`agent:${userID}`).emit("auto-disposition-trigger", {
                status: finalStatus,
                callSid: parentSid
            });
        }

        // Force hangup (safety)
        const twilioClient = Twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );

        try {
            await twilioClient.calls(parentSid).fetch().then(call => {
                if (call.status !== "completed") {
                    return twilioClient.calls(parentSid).update({ status: "completed" });
                }
            });
        } catch (e) {
            // Ignore if already completed
        }

    } catch (err) {
        console.error("Dial Status Error:", err);
    }

    res.sendStatus(200);
});

router.post("/transcription-callback", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { TranscriptionEvent, CallSid, TranscriptionData } = req.body;
    const userID = req.query.userID;

    // Only process if it's the AI Summary event
    if (TranscriptionEvent === 'transcription-summary') {
        const data = JSON.parse(TranscriptionData);
        const aiSummary = data.summary; // This contains the AI generated text

        try {
            // Update your database with the AI summary
            await con.query(`UPDATE CallLogs SET AISummary = ? WHERE CallSID = ?`, [aiSummary, CallSid]);

            // Notify frontend via Socket.io if needed
            if (global.io) {
                global.io.to(`agent:${userID}`).emit("call-summary-ready", {
                    callSid: CallSid,
                    summary: aiSummary
                });
            }
        } catch (err) {
            console.error("Error saving AI Summary:", err);
        }
    }

    res.sendStatus(200);
});

router.post("/transcription-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, TranscriptionText, TranscriptionStatus } = req.body;

    if (TranscriptionStatus === "completed" && TranscriptionText) {
        try {
            await con.query(`UPDATE CallLogs SET Transcript = ? WHERE CallSID = ?`, [TranscriptionText, CallSid]);
            res.sendStatus(200);
        } catch (err) {
            console.error("Transcript save error:", err);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(200);
    }
}
);

router.post("/recording-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, RecordingUrl, RecordingSid, RecordingStatus, RecordingDuration } = req.body;
    if (RecordingStatus === 'completed' && RecordingUrl) {
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

router.post("/call-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, CallStatus } = req.body;

    let dbStatus = CallStatus.toLowerCase();

    // Standardize naming
    if (dbStatus === 'no-answer' || dbStatus === 'canceled') {
        dbStatus = 'No answer';
    } else if (dbStatus === 'busy') {
        dbStatus = 'Busy';
    } else if (dbStatus === 'completed') {
        dbStatus = 'Completed';
    }

    try {
        /**
         * THE LOGIC: 
         * Only allow the update to 'Completed' if the current status is still 'ringing' or 'in-progress'.
         * If /dial-action already set the status to 'No answer', 'Busy', or 'Voicemail', 
         * the WHERE clause will fail, and it won't overwrite your accurate data.
         */
        let query = `
            UPDATE CallLogs 
            SET Status = ? 
            WHERE CallSID = ? 
        `;

        if (dbStatus === 'Completed') {
            // Protect "No answer", "Voicemail", and "Busy" from being overwritten
            query += ` AND (Status NOT IN ('No answer', 'Voicemail', 'Busy', 'Number not in service') OR Status IS NULL OR Status = '')`;
        }

        await con.query(query, [dbStatus, CallSid]);

    } catch (err) {
        console.error("Error updating final status:", err);
    }
    res.sendStatus(200);
});

module.exports = router;