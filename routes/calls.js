require("dotenv").config();
const express = require("express");
const { con } = require("../database");

const router = express.Router();

router.get("/logs", async (req, res) => {
    const { ID, DepartmentID } = req.user;
    const { type, selectedProfile, selectedFile, range } = req.query.filters;

    let query = `
        SELECT 
            CallLogs.Phone, 
            CallLogs.CallSID, 
            CallLogs.RecordingSid, 
            CallLogs.RecordingUrl, 
            CallLogs.AISentiment, 
            CallLogs.AISummary, 
            CallLogs.Status,
            CallLogs.Duration, 
            CallLogs.DialedOn, 
            UserDetails.ID, 
            UserDetails.Name, 
            UserDetails.Email, 
            UserDetails.ProfilePicture
        FROM CallLogs
        JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID
    `;

    let params = [];

    // If NOT admin department, restrict to self
    if (DepartmentID !== 5) {
        query += " WHERE CallLogs.DialedBy = ? AND CallLogs.DialedOn BETWEEN ? AND ? ORDER BY CallLogs.DialedOn DESC";
        params.push(ID, range.startDate, range.endDate);
    } else {
        if (type != 0) {
            if (type == "1") {
                // Admin: Type 1 = Profile-based logs
                if (!selectedProfile || !range) {
                    return res.status(400).json({ error: "selectedProfile and range are required" });
                }
                query += ` WHERE CallLogs.DialedBy = ? AND CallLogs.DialedOn BETWEEN ? AND ? ORDER BY CallLogs.DialedOn DESC `;
                params.push(selectedProfile, range.startDate, range.endDate);
            } else {
                // Admin: Type ≠ 2 → Fetch file details
                if (!selectedFile) return res.status(400).json({ error: "selectedFile is required" });
                query = `
                    SELECT 
                        DialingData.Phone, 
                        DialingData.CallSID, 
                        CallLogs.RecordingSid, 
                        CallLogs.RecordingUrl, 
                        CallLogs.AISentiment, 
                        CallLogs.AISummary, 
                        CallLogs.Status, 
                        CallLogs.Duration, 
                        CallLogs.DialedOn, 
                        UserDetails.ID, 
                        UserDetails.Name, 
                        UserDetails.Email, 
                        UserDetails.ProfilePicture
                    FROM CallLogs
                    JOIN UserDetails ON CallLogs.DialedBy = UserDetails.ID JOIN DialingData ON DialingData.CallSID = CallLogs.CallSID WHERE DialingData.FileID = ?;
                `;
                params = [selectedFile];
            }
        }
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});


module.exports = router;