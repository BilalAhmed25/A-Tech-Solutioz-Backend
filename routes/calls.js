require("dotenv").config();
const express = require("express");
const { con } = require("../database");

const router = express.Router();

router.get("/logs", async (req, res) => {
    const { ID, DepartmentID } = req.user;
    let query = "SELECT CallLogs.Phone, CallLogs.CallSID, CallLogs.RecordingSid, CallLogs.RecordingUrl, CallLogs.AISentiment, CallLogs.AISummary, CallLogs.Status, CallLogs.Duration, CallLogs.DialedOn, UserDetails.ID, UserDetails.Name, UserDetails.Email, UserDetails.ProfilePicture FROM `CallLogs` JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID";
    let params = [];
    if (DepartmentID !== 5) {
        query += " WHERE DialedBy = ?;";
        params.push(16);
        // params.push(ID);
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting working shifts.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

module.exports = router;