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
        await conn.query(` UPDATE SMSConversations SET LastMessage = ?, LastMessageAt = NOW() WHERE ID = ? `, [message, conversationId]);

        await conn.commit();
        res.json({ success: true });

    } catch (err) {
        await conn.rollback();
        console.log(err.message);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

module.exports = router;