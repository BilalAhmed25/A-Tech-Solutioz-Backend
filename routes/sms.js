const express = require('express');
const router = express.Router();
const Twilio = require("twilio");

const { con, attendanceDB } = require('../database');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER } = process.env;

router.get("/conversation/:phone", async (req, res) => {
    const { phone } = req.params;
    const [rows] = await con.query(`SELECT SMSMessages.*, UserDetails.Name FROM SMSMessages JOIN UserDetails ON SMSMessages.SentBy = UserDetails.ID WHERE PhoneNumber = ? ORDER BY ID`, [phone]);
    res.json(rows);
});

router.get("/conversations", async (req, res) => {
    const { ID } = req.user;
    const [rows] = await con.query(`SELECT SMSConversations.ID, PhoneNumber, LastMessage, UserDetails.Name, LastMessageAt FROM SMSConversations JOIN UserDetails ON SMSConversations.CreatedBy = UserDetails.ID WHERE CreatedBy = ? ORDER BY LastMessageAt DESC;`, [ID]);
    res.json(rows);
});

router.post("/send", async (req, res) => {
    const { phoneNumber, message } = req.body;
    const { ID } = req.user;
    const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const conn = await con.getConnection();
    await conn.beginTransaction();

    try {
        // 1. Find or create conversation
        const [existing] = await conn.query("SELECT ID FROM SMSConversations WHERE PhoneNumber = ?", [phoneNumber]);

        let conversationId;

        if (existing.length) {
            conversationId = existing[0].ID;
        } else {
            const [result] = await conn.query("INSERT INTO SMSConversations (PhoneNumber, CreatedBy) VALUES (?, ?)", [phoneNumber, ID]);
            conversationId = result.insertId;
        }

        // 2. Send SMS via Twilio
        const sms = await twilioClient.messages.create({
            from: process.env.TWILIO_NUMBER,
            to: phoneNumber,
            body: message,
        });

        // 3. Save message
        await conn.query(`INSERT INTO SMSMessages (ConversationID, PhoneNumber, Message, Direction, SentBy, TwilioSid) VALUES (?, ?, ?, 'outbound', ?, ?) `, [conversationId, phoneNumber, message, ID, sms.sid]);

        // 4. Update conversation
        await conn.query(`UPDATE SMSConversations SET LastMessage = ?, LastMessageAt = NOW() WHERE ID = ? `, [message, conversationId]);

        await conn.commit();
        if (global.io) {
            global.io.emit("sms_update", {
                conversationId,
                phoneNumber,
                message,
                direction: 'outbound',
                createdAt: new Date()
            });
        }
        res.json({ success: true });

    } catch (err) {
        await conn.rollback();
        console.log(err.message);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

router.post("/incoming", async (req, res) => {
    // Twilio sends data in x-www-form-urlencoded format
    const { From, Body, SmsSid } = req.body;

    const conn = await con.getConnection();
    await conn.beginTransaction();

    try {
        // 1. Find or create conversation based on the 'From' number
        const [existing] = await conn.query(
            "SELECT ID FROM SMSConversations WHERE PhoneNumber = ?",
            [From]
        );

        let conversationId;

        if (existing.length) {
            conversationId = existing[0].ID;
        } else {
            // If it's the first message ever from this person
            const [result] = await conn.query(
                "INSERT INTO SMSConversations (PhoneNumber, CreatedBy) VALUES (?, NULL)",
                [From]
            );
            conversationId = result.insertId;
        }

        // 2. Save the INBOUND message
        await conn.query(
            `INSERT INTO SMSMessages (ConversationID, PhoneNumber, Message, Direction, TwilioSid) 
             VALUES (?, ?, ?, 'inbound', ?)`,
            [conversationId, From, Body, SmsSid]
        );

        // 3. Update conversation last message preview
        await conn.query(
            `UPDATE SMSConversations SET LastMessage = ?, LastMessageAt = NOW() WHERE ID = ?`,
            [Body, conversationId]
        );

        await conn.commit();

        // 4. (Optional) Emit via Socket.io to update the UI instantly
        if (global.io) {
            global.io.emit("sms_update", {
                conversationId,
                phoneNumber: From,
                message: Body,
                direction: 'inbound',
                createdAt: new Date()
            });
        }

        // Twilio requires a TwiML response (even an empty one)
        res.type('text/xml').send('<Response></Response>');

    } catch (err) {
        await conn.rollback();
        console.error("Incoming SMS Error:", err.message);
        res.status(500).send("Error");
    } finally {
        conn.release();
    }
});

module.exports = router;