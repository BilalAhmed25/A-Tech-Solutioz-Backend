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
    const { To, agentId } = req.body;
    const response = new VoiceResponse();

    if (!To) {
        response.say("Invalid number provided.");
        return res.type("text/xml").send(response.toString());
    }

    try {
        // Real-time transcription
        const start = response.start();
        start.transcription({
            statusCallbackUrl: `${BASE_URL_FOR_TWILIO_CALLBACKS}/transcription-callback`,
            transcriptionEngine: 'google',
            track: 'both_tracks',
            languageCode: 'en-US',
            partialResults: true,
            enableAutomaticPunctuation: true,
        });

        const dial = response.dial({
            callerId: TWILIO_NUMBER,
            record: 'record-from-answer',
            recordingStatusCallback: `${BASE_URL_FOR_TWILIO_CALLBACKS}/recording-status`,
            // answerOnBridge: true,
        });

        dial.number(To);
        res.type("text/xml").send(response.toString());
    } catch (error) {
        console.error(error);
        const failResponse = new VoiceResponse();
        failResponse.say("We are unable to process your call right now. Please try again.");
        return res.status(200).type("text/xml").send(failResponse.toString());
    }
});

router.post("/amd-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, AnsweredBy } = req.body;
    try {
        const status = AnsweredBy !== "human" ? AnsweredBy : "Human";
        if (AnsweredBy !== "human") {
            await con.query(`UPDATE DialingData SET Status = ? WHERE CallSID = ?`, [status, CallSid]);
            await con.query(`UPDATE CallLogs SET Status = ? WHERE CallSID = ?`, [status, CallSid]);
            await twilioClient.calls(CallSid).update({ status: "completed" });
        }
    } catch (err) {
        console.error("AMD DB Update Error:", err);
    }
    res.status(200).send("OK");
});

router.post("/transcription-callback", bodyParser.urlencoded({ extended: false }), (req, res) => {
    const event = req.body.TranscriptionEvent;
    const transcriptData = req.body.TranscriptionData
        ? JSON.parse(req.body.TranscriptionData)
        : null;

    if (event === "transcription-content" && transcriptData) {
        global.io.emit("transcript", {
            track: req.body.Track || 'inbound',
            transcript: transcriptData.transcript,
            final: req.body.Final === "true"
        });
    }

    res.sendStatus(200);
});

router.post("/recording-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, RecordingUrl, RecordingSid, RecordingStatus } = req.body;
    if (RecordingStatus === 'completed' && RecordingUrl) {
        try {
            await con.query(
                `UPDATE CallLogs SET RecordingUrl = ?, RecordingSid = ? WHERE CallSID = ?`,
                [RecordingUrl, RecordingSid, CallSid]
            );
            res.sendStatus(200);
        } catch (err) {
            res.sendStatus(500);
            console.error("Error updating recording URL:", err);
        }
    }
});

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
        console.error("Error:", err);
    }
    res.sendStatus(200);
});

module.exports = router;