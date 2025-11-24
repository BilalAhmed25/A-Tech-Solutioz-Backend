const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");
const csv = require("csv-parser");
const { google } = require("googleapis");
const router = express.Router();
const { con } = require('../database');

const auth = new google.auth.GoogleAuth({
    keyFile: "./experts-crm-9d6ac1b67e39.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

// Helper: Convert to CSV URL
function getCsvExportUrl(sheetUrl) {
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return null;
    const sheetId = match[1];
    return { csvUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`, sheetId };
}

router.get("/get-my-google-sheets", async (req, res) => {
    try {
        const { ID } = req.user;
        const [rows] = await con.query("SELECT ID, Name FROM `GoogleSheets` WHERE FIND_IN_SET(?, `Access`) ORDER BY ID DESC;", [ID]);
        res.json(rows);

    } catch (error) {
        console.log('error', error);
        res.status(500).json({ error: error.message });
    }
});

router.get("/fetch-google-sheet", async (req, res) => {
    try {
        const { sheetID } = req.query;
        const [rows] = await con.query("SELECT URL FROM GoogleSheets WHERE ID = ?;", [sheetID]);
        if (!rows.length) return res.status(404).json({ message: "No sheet found in database." });
        const sheetUrl = rows[0].URL;
        // Extract Sheet ID
        const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (!match) return res.status(400).json({ message: "Invalid sheet URL" });
        const sheetId = match[1];
        // Read all rows from Google Sheet
        const auth = new google.auth.GoogleAuth({
            keyFile: "./experts-crm-9d6ac1b67e39.json",
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        });

        const sheets = google.sheets({ version: "v4", auth });
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "Sheet1"
        });

        const rowsData = result.data.values;

        if (!rowsData || rowsData.length === 0) {
            return res.json({ success: true, data: [] });
        }

        // Convert rows → JSON
        const headers = rowsData[0];
        const jsonData = rowsData.slice(1).map((row) => {
            const obj = {};
            headers.forEach((h, i) => {
                obj[h] = row[i] || "";
            });
            return obj;
        });

        res.json({
            success: true,
            data: jsonData
        });

    } catch (error) {
        console.log('error', error);
        res.status(500).json({ error: error.message });
    }
});

router.post("/update-google-sheet", async (req, res) => {
    try {
        const { row, column, value, sheetID } = req.body;
        // row = index starting from 0
        // column = column name e.g. “Name”, "Phone"

        // 1. GET SHEET URL & SHEET ID
        const [rows] = await con.query("SELECT URL FROM GoogleSheets WHERE ID = ?;", [sheetID]);
        if (!rows.length) return res.status(404).json({ message: "No sheet found in database." });

        const sheetUrl = rows[0].URL;
        const { sheetId } = getCsvExportUrl(sheetUrl);

        // 2. GET COLUMN ORDER (header row)
        const sheetMeta = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "Sheet1!1:1"   // HEADER ROW
        });

        const headers = sheetMeta.data.values[0];
        const colIndex = headers.indexOf(column);

        if (colIndex === -1) {
            return res.status(400).json({ message: `Column '${column}' not found in sheet` });
        }

        // Google Sheets rows start at 1, header at row 1 → add +2
        const gRow = row + 2;
        const gCol = colIndex + 1;

        const columnLetter = String.fromCharCode(65 + colIndex); // A B C D...

        const cellRange = `Sheet1!${columnLetter}${gRow}`;

        // ------------------------------------------
        // UPDATE THE CELL IN GOOGLE SHEET
        // ------------------------------------------
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: cellRange,
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[value]]
            }
        });

        res.json({
            success: true,
            message: "Cell updated",
            updatedCell: cellRange,
            value
        });

    } catch (error) {
        console.error("Update Sheet Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
