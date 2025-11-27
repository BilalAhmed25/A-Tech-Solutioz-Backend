require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const xlsx = require("xlsx");
const router = express.Router();

// Config imports
const cloudinary = require("../cloudinaryConfig");
const { twClient, TWILIO_NUMBER } = require("../twilioConfig");

// --- ENV ---
const {
    BASE_URL,
    DIALER_AGENT_NAME = "Dialer",
} = process.env;

const CLOUDINARY_FILE_URL = 'https://res.cloudinary.com/drfbtgfho/raw/upload/v1763880245/leads_files/rhak7lxjsdajsqnintum.xls'
if (!BASE_URL || !CLOUDINARY_FILE_URL) {
    console.error("Missing required env vars. Check .env.");
    process.exit(1);
}

// tmp folder
const TMP_DIR = path.join(__dirname, "tmp");
fs.ensureDirSync(TMP_DIR);

// In-memory map to track callSid -> rowIndex/number
const callMap = new Map();

/* ---------- Helper Functions ---------- */

/**
 * Download Cloudinary file from URL
 */
async function downloadFileFromUrl(fileUrl) {
    const ext = path.extname(fileUrl).split("?")[0] || ".csv";
    const localFile = path.join(TMP_DIR, `cloudfile${ext}`);

    const writer = fs.createWriteStream(localFile);
    const resp = await axios.get(fileUrl, { responseType: "stream" });
    await new Promise((resolve, reject) => {
        resp.data.pipe(writer);
        let error = null;
        writer.on("error", err => { error = err; writer.close(); reject(err); });
        writer.on("close", () => { if (!error) resolve(); });
    });

    return localFile;
}

/**
 * Parse CSV/XLSX into rows (array of objects)
 */
function parseSpreadsheet(localFile) {
    const ext = path.extname(localFile).toLowerCase();
    const workbook = xlsx.readFile(localFile, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    const headers = xlsx.utils.sheet_to_json(sheet, { header: 1 })[0] || [];
    return { rows, headers, workbook, sheetName, ext };
}

/**
 * Save rows to a new workbook and upload to Cloudinary (overwrite)
 */
async function saveAndUpload(rows, headers, workbookInfo) {
    const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, workbookInfo.sheetName || "Sheet1");

    const outPath = path.join(TMP_DIR, `updated_${Date.now()}${workbookInfo.ext || ".xlsx"}`);
    xlsx.writeFile(wb, outPath);

    const uploadResp = await cloudinary.uploader.upload(outPath, {
        resource_type: "raw",
        public_id: CLOUDINARY_FILE_URL.split("/").pop().split(".")[0], // derive public_id from URL
        overwrite: true,
        chunk_size: 6000000,
        use_filename: true,
        unique_filename: false,
    });

    await fs.remove(outPath).catch(() => { });

    return uploadResp;
}

/**
 * Find next un-dialed row
 */
function findNextRow(rows, headers) {
    const statusHeader = headers.find(h => String(h).toLowerCase() === "status") || headers[headers.length - 1];
    for (let i = 0; i < rows.length; i++) {
        const val = rows[i][statusHeader] || "";
        if (!val || String(val).trim() === "") return { index: i, row: rows[i], statusHeader };
    }
    return null;
}

/**
 * Update a row and save/upload
 */
async function updateRowAndUpload({ rows, headers, workbookInfo, rowIndex, updates }) {
    const target = rows[rowIndex];
    if (!target) throw new Error("Row not found");

    Object.keys(updates).forEach(k => {
        if (!headers.includes(k)) headers.push(k);
        target[k] = updates[k];
    });

    const uploadResp = await saveAndUpload(rows, headers, workbookInfo);
    return uploadResp;
}

/* ---------- API Routes ---------- */

/**
 * GET /next - get next number to call
 */
router.get("/next", async (req, res) => {
    try {
        console.log('phone');
        const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
        const { rows, headers } = parseSpreadsheet(localFile);

        const next = findNextRow(rows, headers);
        if (!next) return res.status(204).json({ message: "No numbers available" });

        const phoneKey = Object.keys(next.row).find(k =>
            ["phone", "number", "mobile", "contact"].includes(String(k).toLowerCase())
        );
        
        console.log(phoneKey);
        const phone = phoneKey ? String(next.row[phoneKey] || "").replace(/\D/g, "") : "";
        
        res.json({ success: true, number: phone, rowIndex: next.index, headers, row: next.row });
    } catch (err) {
        console.error("call/next error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /start - start a call
 */
router.post("/start", async (req, res) => {
    try {
        const { number, rowIndex } = req.body;
        if (!number) return res.status(400).json({ success: false, error: "Missing number" });

        // Clean the phone number
        const leadNumber = String(number).replace(/\D/g, "");

        // URL Twilio will request for instructions (TwiML) when the call is answered
        const twimlUrl = `${BASE_URL}/api/twilio/lead-connect?lead=${encodeURIComponent(leadNumber)}`;

        // Create a direct call to the lead
        const call = await twClient.calls.create({
            to: leadNumber,
            from: TWILIO_NUMBER,
            url: twimlUrl, // TwiML instructions
            statusCallback: `${BASE_URL}/api/twilio/call-status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        });

        // Download the spreadsheet from Cloudinary URL
        const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
        const { rows, headers, sheetName, ext } = parseSpreadsheet(localFile);

        // Determine row index
        let rIdx = rowIndex;
        if (rIdx == null) {
            const next = findNextRow(rows, headers);
            rIdx = next ? next.index : null;
        }

        // Update row if found
        if (rIdx != null) {
            const updates = {
                status: "Dialing",
                dialed_by: DIALER_AGENT_NAME,
                callSid: call.sid,
                updated_at: new Date().toISOString(),
            };
            await updateRowAndUpload({
                rows,
                headers,
                workbookInfo: { sheetName, ext },
                rowIndex: rIdx,
                updates,
            });
        }

        // Store in-memory mapping
        callMap.set(call.sid, { number, rowIndex: rIdx });

        res.json({ success: true, callSid: call.sid, rowIndex: rIdx });
    } catch (err) {
        console.error("call/start error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});


/**
 * POST /status-update - update call status
 */
router.post("/status-update", async (req, res) => {
    try {
        const { callSid, status } = req.body;
        if (!callSid || !status) return res.status(400).json({ success: false, error: "Missing params" });

        const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
        const { rows, headers, sheetName, ext } = parseSpreadsheet(localFile);

        const idx = rows.findIndex(r => String(r.callSid || "") === String(callSid));
        if (idx === -1) return res.status(404).json({ success: false, error: "Row with callSid not found" });

        let mappedStatus = status;
        if (["no-answer", "no_answer", "noanswer"].includes(status)) mappedStatus = "No Answer";
        if (status === "completed") mappedStatus = "Completed";
        if (status === "busy") mappedStatus = "Busy";

        const updates = { status: mappedStatus, updated_at: new Date().toISOString() };
        await updateRowAndUpload({ rows, headers, workbookInfo: { sheetName, ext }, rowIndex: idx, updates });

        res.json({ success: true, rowIndex: idx });
    } catch (err) {
        console.error("call/status-update error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /end - end a call
 */
router.post("/end", async (req, res) => {
    try {
        const { callSid, disposition } = req.body;
        if (!callSid || !disposition) return res.status(400).json({ success: false, error: "Missing params" });

        const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
        const { rows, headers, sheetName, ext } = parseSpreadsheet(localFile);

        const idx = rows.findIndex(r => String(r.callSid || "") === String(callSid));
        if (idx === -1) return res.status(404).json({ success: false, error: "Row not found for callSid" });

        const updates = {
            status: disposition,
            disposition,
            dialed_by: DIALER_AGENT_NAME,
            updated_at: new Date().toISOString(),
            callSid: rows[idx].callSid
        };

        await updateRowAndUpload({ rows, headers, workbookInfo: { sheetName, ext }, rowIndex: idx, updates });

        res.json({ success: true, rowIndex: idx });
    } catch (err) {
        console.error("call/end error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ---------- Twilio Webhook Endpoints ---------- */

/**
 * Agent connect TwiML
 */
router.post("/api/twilio/agent-connect", (req, res) => {
    const lead = (req.query.lead || req.body.lead || "").replace(/\D/g, "");
    const twiml = new twilio.twiml.VoiceResponse();

    if (!lead) {
        twiml.say("No lead number provided. Ending call.");
        res.type("text/xml").send(twiml.toString());
        return;
    }

    const dial = twiml.dial({
        callerId: TWILIO_NUMBER,
        action: `${BASE_URL}/api/twilio/bridge-ended?lead=${encodeURIComponent(lead)}`
    });
    dial.number(lead);

    res.type("text/xml").send(twiml.toString());
});

/**
 * Twilio call status callback
 */
router.post("/api/twilio/call-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    console.log("Twilio callback:", callSid, callStatus);

    try {
        const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
        const { rows, headers, sheetName, ext } = parseSpreadsheet(localFile);

        const idx = rows.findIndex(r => String(r.callSid || "") === String(callSid));
        if (idx !== -1) {
            let mapped = callStatus;
            if (callStatus === "no-answer") mapped = "No Answer";
            if (callStatus === "completed") mapped = "Completed";
            if (callStatus === "busy") mapped = "Busy";
            if (callStatus === "failed") mapped = "Failed";

            const updates = { status: mapped, updated_at: new Date().toISOString() };
            await updateRowAndUpload({ rows, headers, workbookInfo: { sheetName, ext }, rowIndex: idx, updates });
        }
    } catch (err) {
        console.error("Error processing Twilio callback:", err);
    }

    res.sendStatus(200);
});

/**
 * Bridge ended webhook
 */
router.post("/api/twilio/bridge-ended", bodyParser.urlencoded({ extended: false }), (req, res) => {
    console.log("Bridge-ended payload:", req.query, req.body);
    res.sendStatus(200);
});

module.exports = router;
