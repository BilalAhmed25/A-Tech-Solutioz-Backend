var express = require('express'),
    multer = require('multer'),
    cloudinary = require('../cloudinaryConfig'),
    router = express.Router(),
    { con } = require('../database');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.get('/get-files', async (req, res) => {
    try {
        const query = "SELECT * FROM `Files` ORDER BY ID DESC";
        const [result] = await con.execute(query);
        res.json(result);

    } catch (error) {
        console.error("An error occured: ", error);
        res.status(500).json("Internal server error.");
    }
});

router.post("/upload-lead-file", upload.array("files"), async (req, res) => {
    try {
        const userId = req.user?.ID;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const uploadResults = [];

        for (const file of req.files) {
            const b64 = Buffer.from(file.buffer).toString("base64");
            const dataURI = `data:${file.mimetype};base64,${b64}`;

            const fileExt = file.originalname.split(".").pop();
            const result = await cloudinary.uploader.upload(dataURI, {
                folder: "leads_files",
                resource_type: "raw",
                format: fileExt,
            });

            // Save in DB
            const [insert] = await con.query(`INSERT INTO Files (FileName, FileType, FileURL, UploadedBy) VALUES (?, ?, ?, ?)`, [file.originalname, file.mimetype, result.secure_url, userId]);

            uploadResults.push({
                id: insert.insertId,
                name: file.originalname,
                type: file.mimetype,
                url: result.secure_url,
            });
        }

        res.json("Files uploaded successfully");
    } catch (error) {
        console.error("Upload error: ", error);
        res.status(500).json({ error: "Upload failed" });
    }
});

router.delete("/delete-lead-file", async (req, res) => {
    const fileId = req.query.fileID;
    const userId = req.user?.ID;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    try {
        // 1. Get file record from DB
        const [rows] = await con.query("SELECT * FROM Files WHERE ID = ?", [fileId]);
        if (!rows.length) return res.status(404).json({ message: "File not found" });

        const file = rows[0];
        const fileURL = file.FileURL;

        // 2. Extract public_id from Cloudinary URL
        const regex = /upload\/(?:v\d+\/)?(.+)\.[^.]+$/;
        const match = fileURL.match(regex);
        if (!match) return res.status(400).json({ error: "Invalid Cloudinary URL format" });

        const publicId = match[1]; // e.g. "uploads/sales_data"

        // 3. Delete from Cloudinary
        await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });

        // 4. Delete from database
        await con.query("DELETE FROM Files WHERE ID = ?", [fileId]);

        res.json("File deleted successfully.");
    } catch (error) {
        console.error("Delete error: ", error);
        res.status(500).json({ error: "Failed to delete file" });
    }
});

module.exports = router;