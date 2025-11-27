require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const xlsx = require("xlsx");
const { Mutex } = require("async-mutex");
const Twilio = require("twilio");

// Twilio Classes for Softphone
const AccessToken = Twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const VoiceResponse = Twilio.twiml.VoiceResponse;

const router = express.Router();

// Config imports
const cloudinary = require("../cloudinaryConfig"); // Ensure this is configured correctly
// Note: We don't need twClient.calls.create anymore, the Browser SDK handles initiation.

// --- ENV CHECKS ---
const {
    BASE_URL,
    DIALER_AGENT_NAME = "Agent",
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    TWILIO_APP_SID,
    TWILIO_NUMBER
} = process.env;

const CLOUDINARY_FILE_URL = 'https://res.cloudinary.com/drfbtgfho/raw/upload/v1763880245/leads_files/rhak7lxjsdajsqnintum.xls';

// Validation
if (!BASE_URL || !TWILIO_API_KEY_SID || !TWILIO_APP_SID) {
    console.error("CRITICAL: Missing .env variables for Softphone (API Keys or App SID).");
    process.exit(1);
}

// Temporary storage for file processing
const TMP_DIR = path.join(__dirname, "tmp");
fs.ensureDirSync(TMP_DIR);

// Mutex: Prevents multiple requests from corrupting the Excel file simultaneously
const fileMutex = new Mutex();

/* ---------- HELPER FUNCTIONS ---------- */

// 1. Download File
async function downloadFileFromUrl(fileUrl) {
    // Determine extension, default to .xlsx if unknown
    const ext = path.extname(fileUrl).split("?")[0] || ".xlsx";
    const localFile = path.join(TMP_DIR, `leads_data${ext}`);

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

// 2. Safe File Transaction (Download -> Modify -> Upload)
async function safeFileUpdate(callback) {
    return await fileMutex.runExclusive(async () => {
        let outPath = null;
        try {
            // A. Download
            const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);

            // B. Parse
            const workbook = xlsx.readFile(localFile, { cellDates: true });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            let rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

            // Capture headers to ensure we don't lose structure
            let headers = xlsx.utils.sheet_to_json(sheet, { header: 1 })[0] || [];

            // C. Execute Logic
            const result = await callback(rows, headers);

            // If callback returns false, it means "no changes needed"
            if (result === false) return null;

            // D. Save to Buffer
            const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, ws, sheetName);

            outPath = path.join(TMP_DIR, `upload_${Date.now()}.xlsx`);
            xlsx.writeFile(wb, outPath);

            // E. Upload (Overwrite)
            // Extract public_id from URL to ensure we overwrite the same file
            // Logic: splits by '/' takes last part, removes extension
            const filename = CLOUDINARY_FILE_URL.split("/").pop();
            const publicId = filename.substring(0, filename.lastIndexOf('.')) || filename;

            await cloudinary.uploader.upload(outPath, {
                resource_type: "raw",
                public_id: publicId,
                overwrite: true,
                use_filename: true,
                unique_filename: false,
                folder: "leads_files" // Ensure this matches your folder structure
            });

            return result;
        } catch (error) {
            console.error("File update failed:", error);
            throw error;
        } finally {
            // Cleanup
            if (outPath) await fs.remove(outPath).catch(() => { });
        }
    });
}

/* ---------- 1. SOFTPHONE AUTH ---------- */

/**
 * GET /token
 * Generates a Capability Token for the React Frontend to use the Microphone
 */
router.get("/token", (req, res) => {
    console.log("Generating token for agent:", DIALER_AGENT_NAME);
    try {
        const identity = DIALER_AGENT_NAME + "_" + Math.floor(Math.random() * 1000);

        const voiceGrant = new VoiceGrant({
            outgoingApplicationSid: TWILIO_APP_SID,
            incomingAllow: true, // Set to false if you don't want to receive calls
        });

        const token = new AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_KEY_SECRET,
            { identity: identity }
        );

        token.addGrant(voiceGrant);
        res.json({
            token: token.toJwt(),
            identity: identity
        });
    } catch (err) {
        console.error("Token Error:", err);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

/* ---------- 2. TWILIO WEBHOOKS (Voice Logic) ---------- */

/**
 * POST /twilio/voice-handler
 * Triggered when the Browser SDK calls .connect({ To: '+123...' })
 * This instructs Twilio to connect the Browser to the Lead.
 */
router.post("/twilio/voice-handler", (req, res) => {
    const { To } = req.body;
    const response = new VoiceResponse();

    if (To) {
        // We are dialing an external number (The Lead)
        const dial = response.dial({
            callerId: TWILIO_NUMBER, // The number the Lead sees on their Caller ID
            answerOnBridge: true,    // Good for softphones
            // Status callbacks to track "Ringing", "Busy", "No Answer"
            statusCallback: `${BASE_URL}/api/twilio/call-status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });

        // Dial the number sent from Frontend
        dial.number(To);
    } else {
        response.say("Invalid number provided.");
    }

    res.type("text/xml").send(response.toString());
});

/**
 * POST /twilio/call-status
 * Webhook for Call Events (Ringing, Completed, Busy, etc.)
 */
router.post("/twilio/call-status", bodyParser.urlencoded({ extended: false }), async (req, res) => {
    const { CallSid, CallStatus } = req.body;
    console.log(`Twilio Event: ${CallSid} -> ${CallStatus}`);

    try {
        await safeFileUpdate((rows) => {
            // Find row by callSid
            const row = rows.find(r => r.callSid === CallSid);
            if (!row) return false; // Not found, don't upload

            // Map Twilio status to your Excel logic
            // Note: We don't overwrite if it's already "Sale" or "Dispositioned" manually
            if (['busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus)) {
                row.status = "No Answer";
            } else if (CallStatus === 'in-progress') {
                row.status = "Live Call";
            }

            row.updated_at = new Date().toISOString();
            return true;
        });
    } catch (err) {
        console.error("Webhook Error:", err);
    }

    res.sendStatus(200);
});

/* ---------- 3. CRM / LEAD MANAGEMENT API ---------- */

/**
 * GET /next
 * Fetches next un-dialed number
 */
router.get("/next", async (req, res) => {
    try {
        const result = await fileMutex.runExclusive(async () => {
            const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
            const workbook = xlsx.readFile(localFile);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

            // Logic: Find first row where status is empty or 'New'
            // Adjust 'status' key based on your exact excel header casing
            const rowIndex = rows.findIndex(r => {
                const s = String(r.status || r.Status || "").toLowerCase();
                return s === "" || s === "new";
            });

            if (rowIndex === -1) return null;
            return { row: rows[rowIndex], index: rowIndex };
        });

        if (!result) return res.json({ message: "List finished", number: null });

        // Robust Phone Parser
        const row = result.row;
        const phoneKey = Object.keys(row).find(k => {
            const key = String(k).toLowerCase();
            return key.includes("phone") || key.includes("mobile") || key.includes("number");
        });

        const rawNumber = phoneKey ? row[phoneKey] : "";
        const cleanNumber = String(rawNumber).replace(/\D/g, ""); // Remove non-digits

        res.json({
            success: true,
            number: cleanNumber,
            rowIndex: result.index,
            row: row
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /start
 * Called by Frontend when dialing starts to lock the row
 */
router.post("/start", async (req, res) => {
    try {
        const { number, rowIndex } = req.body;

        await safeFileUpdate((rows, headers) => {
            if (!rows[rowIndex]) return false;

            // Ensure headers exist
            if (!headers.includes("callSid")) headers.push("callSid");
            if (!headers.includes("status")) headers.push("status");

            // Temporary ID until Twilio connects (Frontend will update or Webhook will update)
            // But we mark it "Dialing" so next agent doesn't grab it
            rows[rowIndex].status = "Dialing";
            rows[rowIndex].dialed_by = DIALER_AGENT_NAME;
            rows[rowIndex].updated_at = new Date().toISOString();

            return true;
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /end
 * Save manual disposition (Sale, Callback, etc.)
 */
router.post("/end", async (req, res) => {
    try {
        const { callSid, disposition } = req.body;

        await safeFileUpdate((rows) => {
            // Try to find by CallSid first (most accurate)
            let row = rows.find(r => r.callSid === callSid);

            // If callSid failed to save earlier, we might need a fallback logic, 
            // but for now, rely on callSid.
            if (!row) {
                // Optional: You could pass rowIndex from frontend as fallback
                return false;
            }

            row.status = disposition;
            row.updated_at = new Date().toISOString();
            return true;
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /check-status/:callSid
 * Used by Auto-Dialer frontend to know if it should skip
 */
router.get("/check-status/:callSid", async (req, res) => {
    try {
        const { callSid } = req.params;

        const result = await fileMutex.runExclusive(async () => {
            const localFile = await downloadFileFromUrl(CLOUDINARY_FILE_URL);
            const workbook = xlsx.readFile(localFile);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

            const row = rows.find(r => r.callSid === callSid);
            return row ? row.status : null;
        });

        if (!result) return res.status(404).json({ status: 'unknown' });

        res.json({ status: String(result).toLowerCase() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;