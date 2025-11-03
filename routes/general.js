var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    nodemailer = require('nodemailer'),
    fs = require('fs'),
    cloudinary = require("../cloudinaryConfig"),
    { Readable } = require("stream"),
    multer = require("multer"),
    axios = require('axios'),
    router = express.Router();

const { con } = require('../database');
const sendEmail = require('../sendEmail');
router.use(bodyParser.urlencoded({ extended: true }));

const storage = multer.memoryStorage(); // Store files in memory as Buffers

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 8 * 1024 * 1024 // 8MB limit per file
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed.'), false); // Pass error to Multer
        }
    }
});

router.post('/upload-mca-lead', async (req, res) => {
    // Wrap multer call inside the route
    upload.array('bankStatements', 10)(req, res, async function (err) {
        try {
            if (err instanceof multer.MulterError) {
                let errorMessage = 'File upload error.';
                if (err.code === 'LIMIT_FILE_SIZE') {
                    errorMessage = 'One or more files are too large. Max size is 8MB per file.';
                } else {
                    errorMessage = `Multer error: ${err.message}`;
                }
                return res.status(400).json({ success: false, message: errorMessage });
            } else if (err) {
                // File filter or unknown multer error
                return res.status(400).json({ success: false, message: err.message || 'Unknown file upload error.' });
            }

            // ✅ Now safe to use req.body and req.files
            const {
                BusinessName,
                BusinessUnderDifferentName,
                Address,
                City,
                State,
                ZIPCode,
                Country,
                BusinessStartingYear,
                BusinessPhone,
                LegalEntityType,
                OtherLoans,
                TaxID,
                AnnualGrossRevenue,
                FirstName,
                LastName,
                ResidentialAddress,
                ResidentialCity,
                ResidentialState,
                ResidentialCountry,
                PersonalPhone,
                email,
                DOB,
                NumberOfBusinesses,
                SocialSecurityNumber,
                esignature
            } = req.body;

            const files = req.files;
            const uploadedFileUrls = [];

            if (files && files.length > 0) {
                for (const file of files) {
                    const uploadResult = await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`, {
                        folder: 'mca_leads_documents'
                    });
                    uploadedFileUrls.push(uploadResult.secure_url);
                }
            }

            const documentsURLs = uploadedFileUrls.join(',');
            const values = [
                BusinessName,
                BusinessUnderDifferentName,
                Address,
                City,
                State,
                ZIPCode,
                Country,
                BusinessStartingYear,
                BusinessPhone,
                LegalEntityType,
                OtherLoans,
                TaxID,
                AnnualGrossRevenue,
                FirstName,
                LastName,
                ResidentialAddress,
                ResidentialCity,
                ResidentialState,
                ResidentialCountry,
                PersonalPhone,
                email,
                DOB,
                NumberOfBusinesses,
                SocialSecurityNumber,
                documentsURLs,
                esignature === 'true' ? 1 : 0
            ];

            const query = `
                INSERT INTO MCALeads (
                    BusinessName,
                    BusinessUnderDifferentName,
                    Address,
                    City,
                    State,
                    ZIPCode,
                    Country,
                    BusinessStartingYear,
                    BusinessPhone,
                    LegalEntityType,
                    OtherLoans,
                    TaxID,
                    AnnualGrossRevenue,
                    FirstName,
                    LastName,
                    ResidentialAddress,
                    ResidentialCity,
                    ResidentialState,
                    ResidentialCountry,
                    PersonalPhone,
                    EmailAddress,
                    DOB,
                    NumberOfBusinesses,
                    SocialSecurityNumber,
                    DocumentsURLs,
                    eSignature
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            await con.execute(query, values);

            const templatePath = path.join(__dirname, '../email-templates/loan-application-confirmation-email.html');
            let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
            htmlTemplate = htmlTemplate.replace('{{fullName}}', FirstName + ' ' + LastName);

            await sendEmail(
                `"Experts Funding Group" <${process.env.SMTP_USER}>`,
                email,
                'Thank you for choosing Experts Funding Group',
                htmlTemplate,
                [
                    {
                        filename: 'logo-dark.png',
                        path: path.join(__dirname, '../email-templates/images/logo-dark.png'),
                        cid: 'logo'
                    }
                ],
                {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT),
                    secure: true,
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS,
                    },
                }
            );

            res.status(200).json({ success: true, message: 'Application submitted successfully!' });
        } catch (error) {
            console.error('Internal error:', error);
            let message = 'Something went wrong. Please try again.';
            if (error.http_code) {
                message = 'Cloudinary upload failed: ' + error.message;
                return res.status(error.http_code).json({ success: false, message });
            }
            res.status(500).json({ success: false, message });
        }
    });
});

router.get('/get-mca-leads', async function (req, res) {
    const query = `SELECT * FROM MCALeads ORDER BY ID DESC`;
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting MCA leads.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.put('/update-mca-lead-seen-status', async function (req, res) {
    const { LeadID, SeenStatus } = req.body;
    const query = `UPDATE MCALeads SET Seen = ? WHERE ID = ?`;
    try {
        const [result] = await con.execute(query, [SeenStatus, LeadID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while updating MCA lead seen status.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-mca-lead', async (req, res) => {
    let { IDs } = req.query;
    if (!Array.isArray(IDs)) {
        IDs = [IDs];
    }

    if (IDs.length === 0) {
        return res.status(400).json({ message: 'No ID(s) provided.' });
    }

    try {
        const placeholders = IDs.map(() => '?').join(',');
        const sql = `DELETE FROM MCALeads WHERE ID IN (${placeholders})`;
        const [result] = await con.execute(sql, IDs);
        res.json({ message: 'Lead has been deleted successfully.', affectedRows: result.affectedRows });
    } catch (error) {
        console.error('Error deleting lead(s).', error);
        res.status(500).json({ message: 'Error deleting lead(s).' });
    }
});

router.get('/get-all-employee', async function (req, res) {
    const { userID, email, status } = req.query;
    const params = [];
    let query = "SELECT UserDetails.*, DepartmentName, DesignationTitle, Shifts.Name AS 'WorkingShift', Shifts.ID AS 'ShiftID' FROM `UserDetails` LEFT JOIN Departments ON `UserDetails`.DepartmentID = Departments.ID LEFT JOIN Designations ON `UserDetails`.DesignationID = Designations.ID LEFT JOIN UserShiftAssignments ON `UserDetails`.ID = UserShiftAssignments.UserID LEFT JOIN Shifts ON UserShiftAssignments.ShiftID = Shifts.ID WHERE (UserDetails.DepartmentID IS NULL OR UserDetails.DepartmentID != 5)";
    if (userID) {
        query += " AND `UserDetails`.ID = ?";
        params.push(userID);
    }
    if (email) {
        query += " AND `UserDetails`.Email = ?";
        params.push(email);
    }
    if (status) {
        query += " AND `UserDetails`.Status = ?";
        params.push(status);
    }
    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting port details.", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.get('/get-departments', async function (req, res) {
    const query = `SELECT * FROM Departments`;
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting Departments.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.get('/get-active-shifts', async function (req, res) {
    const query = "SELECT Shifts.Name, ShiftDurations.* FROM `Shifts` JOIN ShiftDurations ON Shifts.ID = ShiftDurations.ShiftID WHERE ShiftDurations.EndDate IS NULL;";
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting working shifts.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.put('/update-profile', async function (req, res) {
    const {
        name,
        email,
        phone,
        password,
        dateOfBirth,
        departmentId,
        designationId,
        residentialAddress,
        languages,
        country,
        state,
        city,
        accountType,
        status
    } = req.body;

    if (!email) {
        return res.status(400).json({ error: "Email is required to update profile." });
    }

    const query = `
        UPDATE UserDetails SET 
            Name = ?, 
            Phone = ?, 
            Password = ?,
            DOB = ?,
            DepartmentID = ?, 
            DesignationID = ?, 
            ResidentialAddress = ?, 
            Languages = ?,
            Country = ?,
            State = ?,
            City = ?,
            AccountType = ?, 
            Status = ?
        WHERE Email = ?;
    `;

    try {
        const [result] = await con.execute(query, [
            name,
            phone,
            password,
            dateOfBirth,
            departmentId,
            designationId,
            residentialAddress,
            languages,
            country,
            state,
            city,
            accountType || null,
            status,
            email
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "User not found or no changes made." });
        }

        res.status(200).json({ message: "Profile updated successfully." });
    } catch (error) {
        console.error("Error while updating profile:", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});


router.put('/update-profile-picture', async (req, res) => {
    try {
        const { imageData, email } = req.body;
        const result = await cloudinary.uploader.upload(imageData, {
            folder: 'profile_pictures',
        });
        const imageUrl = result.secure_url;
        const [rows] = await con.execute('UPDATE UserDetails SET ProfilePicture = ? WHERE Email = ?', [imageUrl, email]);

        if (rows.affectedRows > 0) {
            const oldToken = req.headers['authorization'];
            if (!oldToken) {
                return res.status(401).json('Unauthorized: Token missing');
            }

            jwt.verify(oldToken, process.env.SECRET_KEY, (err, decoded) => {
                if (err) {
                    if (err instanceof jwt.TokenExpiredError) return res.status(403).json("Token is expired. Please re-login to continue.");
                    else if (err instanceof jwt.JsonWebTokenError) return res.status(401).json("You are not authorized.");
                    else return res.status(401).json("You are not authorized.");
                }

                const updatedUserData = {
                    ...decoded,
                    ProfilePicture: imageUrl,
                };

                delete updatedUserData.exp;
                delete updatedUserData.iat;

                const newToken = jwt.sign(updatedUserData, process.env.SECRET_KEY, { expiresIn: '10h' });
                res.json({ message: 'Profile picture updated successfully.', token: newToken });
            });
        } else {
            res.status(404).json('User not found.');
        }
    } catch (error) {
        console.error('Error updating profile picture:', error);
        res.status(500).json({ message: 'Failed to update profile picture.' });
    }
});

router.get('/get-brands', async function (req, res) {
    const query = `SELECT * FROM Brands`;
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting Brands.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});


router.post('/update-password', async function (req, res) {
    const { userID, oldPassword, newPassword } = req.body;
    try {
        const [rows] = await con.execute("SELECT Password FROM UserDetails WHERE UserID = ?", [userID]);

        if (rows.length === 0) {
            return res.status(404).json("User not found.");
        }

        const currentPassword = rows[0].Password;

        // Step 2: Compare oldPassword with the current password
        if (currentPassword !== oldPassword) {
            return res.status(400).json("Old password is incorrect.");
        }

        // Step 3: If new password is the same as old password
        if (currentPassword === newPassword) {
            return res.status(400).json("New password cannot be the same as the old password.");
        }

        // Step 4: Update the password
        const [result] = await con.execute(
            "UPDATE UserDetails SET Password = ? WHERE UserID = ?",
            [newPassword, userID]
        );

        res.status(200).json("Successfully updated password.");
    } catch (error) {
        console.error("An error occurred while updating password:", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

// Utility: Generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

router.get('/get-all-clients', async function (req, res) {
    const { userID, email } = req.query;
    let query = "SELECT * FROM ClientDetails";
    const params = [];

    if (userID) {
        query += " WHERE ID = ?";
        params.push(userID);
    } else if (email) {
        query += " WHERE Email = ?";
        params.push(email);
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting client details.", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.get('/get-orders', async function (req, res) {
    const { userID, clientID } = req.query;
    let query = "SELECT * FROM Orders";
    const params = [];

    if (userID) {
        query += " WHERE CreatedBy = ?;";
        params.push(userID);
    } else if (clientID) {
        query += " WHERE ClientID = ?;";
        params.push(clientID);
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occurred while getting orders.", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
});


// Email transporter setup
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

router.post('/send-otp', async (req, res) => {
    const { email, password } = req.body;
    const otp = generateOTP();
    const templatePath = path.join(__dirname, '../email-templates/otp-email-template.html');
    let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
    htmlTemplate = htmlTemplate.replace('{{OTP}}', otp);

    const mailOptions = {
        from: process.env.SMTP_USER,
        to: email,
        subject: 'OTP for password reset.',
        html: htmlTemplate,
        priority: 'high',
        attachments: [
            {
                filename: 'logo.png',
                path: path.join(__dirname, '../email-templates/images/logo.webp'),
                cid: 'logo' // same as in HTML img src
            }
        ]
    };

    try {
        const query = "SELECT * FROM UserDetails WHERE Email=?";
        const [result] = await con.execute(query, [email]);
        if (result.length === 1) {
            await transporter.sendMail(mailOptions);
            res.json({ success: true, otp });
        } else {
            res.json({ success: false, message: 'Please enter a valid email address.' });
        }

    } catch (error) {
        console.error('Email sending failed:', error);
        res.status(500).json({ success: false, message: 'Failed to send OTP.' });
    }
});

router.post('/update-password-with-email', async (req, res) => {
    const { emailForPasswordUpdate, password } = req.body;
    try {
        const query = "UPDATE UserDetails SET Password = ? WHERE Email = ?";
        const [result] = await con.execute(query, [password, emailForPasswordUpdate]);
        res.json('Successfully updated password.');
    } catch (error) {
        console.error('Email sending failed:', error);
        res.status(500).json('An error occured while updating password.');
    }
});

router.post('/create-client-profile', async function (req, res) {
    const { name, email, phone, company, designation, address, country, state, city, dateOfBirth, languages, leadSource, assignedTo, lastContactedDate, notes } = req.body;

    if (!email || !name || !phone) {
        return res.status(400).json({ error: "Name, email, and phone are required." });
    }

    const query = `
        INSERT INTO ClientDetails (Name, Email, Phone, Company, Designation, Address, Country, State, City, DOB, Languages, LeadSource, AssignedTo, LastContactedDate, Notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    try {
        const [result] = await con.execute(query, [name, email, phone, company, designation, address, country, state, city, dateOfBirth, languages, leadSource, assignedTo, lastContactedDate, notes]);
        res.status(201).json({ message: "Client added successfully.", clientID: result.insertId });
    } catch (error) {
        console.error("Error inserting client:", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.put('/update-client-profile', async function (req, res) {
    const { clientID, name, email, phone, company, designation, address, country, state, city, dateOfBirth, languages, leadSource, assignedTo, lastContactedDate, notes } = req.body;
    if (!clientID) {
        return res.status(400).json({ message: "Client ID is required for update." });
    }

    const query = `
        UPDATE ClientDetails SET 
            Name = ?, Email = ?, Phone = ?, Company = ?, Designation = ?, Address = ?,
            Country = ?, State = ?, City = ?, DOB = ?, Languages = ?, 
            LeadSource = ?, AssignedTo = ?, LastContactedDate = ?, 
            Notes = ?
        WHERE ID = ?;
    `;

    try {
        const [result] = await con.execute(query, [name, email, phone, company, designation, address, country, state, city, dateOfBirth, languages, leadSource, assignedTo, lastContactedDate, notes, clientID]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Client not found or no changes made." });
        }
        res.status(200).json({ message: "Client updated successfully." });
    } catch (error) {
        console.error("Error updating client:", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-client-profile', async function (req, res) {
    try {
        const [result] = await con.execute("DELETE FROM `ClientDetails` WHERE `ID` = ?", [req.query.clientID]);
        if (result.affectedRows > 0) {
            res.json('Success');
        } else {
            res.status(404).json('Profile not found');
        }
    } catch (err) {
        console.error("Error deleting profile:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});


router.put('/update-client-type', async function (req, res) {
    try {
        const { ClientType, clientID } = req.body;
        const [result] = await con.execute("UPDATE `ClientDetails` SET ClientType = ? WHERE `ID` = ?", [ClientType, clientID]);
        if (result.affectedRows > 0) {
            res.json('Success');
        } else {
            res.status(404).json('Profile not found');
        }
    } catch (err) {
        console.error("Error updating profile:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.put('/update-assigned-agent', async function (req, res) {
    try {
        const { AssignedTo, clientID } = req.body;
        const [result] = await con.execute("UPDATE `ClientDetails` SET AssignedTo = ? WHERE `ID` = ?", [AssignedTo, clientID]);
        if (result.affectedRows > 0) {
            res.json('Success');
        } else {
            res.status(404).json('Profile not found');
        }
    } catch (err) {
        console.error("Error updating profile:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.get('/get-client-types', async function (req, res) {
    try {
        const [result] = await con.execute("SELECT * FROM `ClientTypes`");
        res.json(result);
    } catch (err) {
        console.error("Error getting client types:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

router.get('/get-project-types', async function (req, res) {
    try {
        const [result] = await con.execute("SELECT * FROM `ProjectTypes`");
        res.json(result);
    } catch (err) {
        console.error("Error getting project types:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

const uploadFileToCloudinary = async (buffer, fileName) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: "raw",
                public_id: `CVs/${fileName}`,
                unique_filename: false,
                overwrite: false,
                invalidate: true
            },
            (error, result) => {
                if (error) {
                    return reject(error);
                }
                resolve(result.secure_url);
            }
        );

        Readable.from(buffer).pipe(stream);
    });
};

const uploadCV = multer({
    storage: storage,
    limits: {
        fileSize: 2 * 1024 * 1024 // 2MB limit per file
    },
});

router.post("/post-job-application", uploadCV.single("file"), async (req, res) => {
    try {
        let fileUrl = "";

        if (req.file) {
            const parsed = path.parse(req.file.originalname);
            const fullFileName = `${parsed.name}${parsed.ext}`; // ensures extension is preserved
            fileUrl = await uploadFileToCloudinary(req.file.buffer, fullFileName);
            // fileUrl = await uploadFileToCloudinary(req.file.buffer, req.file.filename);
        }

        const formData = { ...req.body, 'uploaded-file-name': fileUrl };

        await axios.post(
            "https://script.google.com/macros/s/AKfycbwEiSA2DbAhWHT6tSQgZEhQltMRpmsdzQtQjFSaLEVSq_n6Hbv79ZsZyVTTSxhS0mOq/exec",
            formData,
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
        res.status(200).send("Success");
    } catch (error) {
        console.error("Error submitting form:", error.response?.data || error.message);
        res.status(500).send("Internal Server Error");
    }
});

module.exports = router;