const express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    { con } = require('../database'),
    cloudinary = require("../cloudinaryConfig"),
    { CloudinaryStorage } = require("multer-storage-cloudinary"),

    multer = require("multer"),
    cors = require("cors"),
    router = express.Router();

router.get('/', function (req, res) {
    res.status(200).json('Ok');
})

router.post('/upload-dynamic-values', async function (req, res) {
    const { category, bindWith, values, freightRate } = req.body;
    const lines = values.split(/\r?\n/);
    let query = '';

    switch (category) {
        case 'Category':
            query = `INSERT INTO InventoryCategories (InventoryCategory) VALUES (?)`;
            break;
        case 'Type':
            query = `INSERT INTO InventoryTypes (InventoryCategoryID, InventoryType) VALUES (?,?)`;
            break;
        case 'Make':
            query = `INSERT INTO InventoryMakes (InventoryTypeID, InventoryMake) VALUES (?,?)`;
            break;
        case 'Model':
            query = `INSERT INTO InventoryModels (InventoryMakeID, InventoryModel) VALUES (?,?)`;
            break;
        case 'Port':
            query = `INSERT INTO PortDetails(Country, Port, FreightRate) VALUES (?,?,?)`;
            break;
        default:
            query = `INSERT INTO InventoryDropdownValues (ValueType, Value) VALUES (?, ?)`;
    }

    try {
        for (const line of lines) {
            if (category === 'Category') {
                await con.execute(query, [line]);
            } else if (['Type', 'Make', 'Model'].includes(category)) {
                await con.execute(query, [bindWith, line]);
            } else if (category === 'Port') {
                await con.execute(query, [bindWith, line, freightRate ? freightRate : 0]);
            } else {
                await con.execute(query, [category, line]);
            }
        }
        res.status(200).json(`Successfully inserted ${lines.length} value(s) for ${category}.`);
    } catch (error) {
        console.error("An error occured while getting bank details.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-all-inventory-dropdowns', async (req, res) => {
    try {
        const [result] = await con.execute('SELECT * FROM InventoryDropdownValues');
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventory dropdowns.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.get('/get-inventory-category', async function (req, res) {
    try {
        const query = "SELECT * FROM InventoryCategories";
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventory category.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-inventory-type', async function (req, res) {
    const { InventoryCategoryID } = req.query;
    let query = "SELECT * FROM InventoryTypes";
    let params = [];

    if (InventoryCategoryID) {
        query += " WHERE InventoryCategoryID = ?"
        params.push(InventoryCategoryID);
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventory type.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-inventory-make', async function (req, res) {
    const { InventoryTypeID } = req.query;
    let query = "SELECT * FROM InventoryMakes";
    let params = [];

    if (InventoryTypeID) {
        query += " WHERE InventoryTypeID = ?";
        params.push(InventoryTypeID);
    }

    try {
        const [result] = await con.execute(query, params);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventory make.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-inventory-model', async function (req, res) {
    const { InventoryMakeID } = req.query;
    const query = "SELECT * FROM InventoryModels WHERE InventoryMakeID = ?";
    try {
        const [result] = await con.execute(query, [InventoryMakeID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventory model.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

// router.get('/get-all-inventory-type', async function (req, res) {
//     const query = "SELECT * FROM InventoryTypes";
//     try {
//         const [result] = await con.execute(query);
//         res.status(200).json(result);
//     } catch (error) {
//         console.error("An error occured while getting inventory type.", error);
//         res.status(500).json({ error: "Internal server error. Please try again later." });
//     }
// })

// router.get('/get-all-inventory-make', async function (req, res) {
//     const query = "SELECT * FROM InventoryMakes";
//     try {
//         const [result] = await con.execute(query);
//         res.status(200).json(result);
//     } catch (error) {
//         console.error("An error occured while getting inventory make.", error);
//         res.status(500).json({ error: "Internal server error. Please try again later." });
//     }
// })

router.get('/get-bank-details', async function (req, res) {
    const query = "SELECT ID, BankName FROM BankDetails";
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting bank details.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-my-listings', async function (req, res) {
    const { userID } = req.query;
    let query = "SELECT * FROM Inventories";
    let parameter = [];
    if (userID) {
        query += " WHERE Created_By = ?";
        parameter.push(userID);
    }

    try {
        const [result] = await con.execute(query, parameter);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventories.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-consignees', async function (req, res) {
    const query = "SELECT * FROM ConsigneeDetails WHERE UserID = ?";
    const { userID } = req.query;
    try {
        const [result] = await con.execute(query, [userID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting bank details.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-all-profiles', async function (req, res) {
    const query = "SELECT * FROM UserDetails";
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting bank details.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/update-inquiry-status', async function (req, res) {
    const { inquiryID, inquiryStatus, comments, userID } = req.body;
    let query = "UPDATE InquirySubmissions SET Status = ?, HandleBy = ?, Comments = ? WHERE ID = ?";
    const ID = req.params.ID;

    try {
        const result = await con.execute(query, [inquiryStatus, userID, comments, inquiryID]);
        res.status(200).json('Successfuly updated inquiry status.');
    } catch (error) {
        console.error("An error occurred while updating inquiry status.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.post('/update-reservation-status', async function (req, res) {
    const { reservationID, reservationStatus, discount, userID } = req.body;
    let query = "UPDATE ReservedAndSoldInventories SET Status = ?, HandleBy = ?, Discount = ? WHERE ID = ?";

    try {
        const result = await con.execute(query, [reservationStatus, userID, discount, reservationID]);
        res.status(200).json('Successfuly updated reservation status.');
    } catch (error) {
        console.error("An error occurred while updating reservation status.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.get('/get-all-countries', async function (req, res) {
    const query = "SELECT Country AS 'ID', Country FROM PortDetails GROUP BY Country;";
    try {
        const [result] = await con.execute(query);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inventories.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/update-profile-status', async function (req, res) {
    const { profileStatus, accessType, userID } = req.body;
    if (!userID) {
        return res.status(400).json({ error: "UserID is required." });
    }

    let fieldsToUpdate = [];
    let values = [];

    if (profileStatus) {
        fieldsToUpdate.push("Status = ?");
        values.push(profileStatus);
    }

    if (accessType) {
        fieldsToUpdate.push("UserType = ?");
        values.push(accessType);
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: "Nothing to update. Provide at least profileStatus or accessType." });
    }

    values.push(userID); // Add UserID for WHERE clause

    const query = `UPDATE UserDetails SET ${fieldsToUpdate.join(', ')} WHERE UserID = ?`;
    // let query = "UPDATE UserDetails SET Status = ? WHERE UserID = ?";

    try {
        const result = await con.execute(query, values);
        res.status(200).json('Successfuly updated profile status.');
    } catch (error) {
        console.error("An error occurred while updating profile status.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-listing/:ID', async function (req, res) {
    let query = "DELETE FROM Inventories WHERE ID=?";
    const ID = req.params.ID;

    try {
        const result = await con.execute(query, [ID]);
        res.status(200).json('Successfuly deleted listing.');
    } catch (error) {
        console.error("An error occurred while deleting listing.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-profile/:ID', async function (req, res) {
    let query = "DELETE FROM UserDetails WHERE UserID=?";
    const ID = req.params.ID;
    try {
        const result = await con.execute(query, [ID]);
        res.status(200).json('Successfuly deleted profile.');
    } catch (error) {
        console.error("An error occurred while deleting profile.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-inquiry/:ID', async function (req, res) {
    let query = "DELETE FROM InquirySubmissions WHERE ID=?";
    const ID = req.params.ID;

    try {
        const result = await con.execute(query, [ID]);
        res.status(200).json('Successfuly deleted inquiry.');
    } catch (error) {
        console.error("An error occurred while delete inquiry.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.delete('/delete-reservation/:ID', async function (req, res) {
    const query = "DELETE FROM `ReservedAndSoldInventories` WHERE `ID` = ?;";
    const ID = req.params.ID;

    try {
        const [result] = await con.execute(query, [ID]);
        res.status(200).json('Successsfully deleted reservation.');
    } catch (error) {
        console.error("An error occured while adding to favourites.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

const storage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: "inventory_images",
        format: async (req, file) => "jpg", // Convert to JPG
        public_id: (req, file) => Date.now() + "-" + file.originalname,
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 800 * 1024 }, // 800KB max per file
});

// API to Upload Inventory
router.post("/upload-inventory", upload.fields([{ name: "featuredImage", maxCount: 1 }, { name: "galleryImages", maxCount: 10 },]), async (req, res) => {
    try {
        const {
            userID, condition, categoryID, type, make, model, offerType, driveType,
            transmission, fuelType, cylinders, color, doors, featureCategory,
            features, steering, title, price, description, tagline, year, hours,
            m3, sourceLink, overHeight, bankDetails
        } = req.body;

        // Check if files exist
        const featuredImageUrl = req.files["featuredImage"] ? req.files["featuredImage"][0].path : null;
        let galleryImageUrls = req.files["galleryImages"] ? req.files["galleryImages"].map(file => file.path).join(",") : null;
        galleryImageUrls = galleryImageUrls.replace(/["']/g, '').replace(/,+/g, ',').replace(/^,|,$/g, ''); //added
        // Insert into database
        const query = `
                INSERT INTO Inventories 
                (Conditions, Categories, Types, Makes, Models, Offer_Types, Drive_Types, Transmissions, 
                Fuel_Types, Cylinders, Colors, Doors, Features_Categories, Features, Steering, Price, 
                Title, Featured_Image, Gallery_Images, Description, Tagline, Year, Hours, M3, 
                Source_Link, Over_Height, Bank, Created_By, Created_At) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `;

        const values = [
            condition, categoryID, type, make, model, offerType, driveType,
            transmission, fuelType, cylinders, color, doors, featureCategory,
            features, steering, price, title, featuredImageUrl, galleryImageUrls,
            description, tagline, year, hours, m3, sourceLink, overHeight, bankDetails, userID
        ];

        const [result] = await con.execute(query, values);

        if (result.affectedRows > 0) {
            return res.status(200).json(`Inventory uploaded successfully. ID: ${result.insertId}.`);
        } else {
            return res.status(500).json("Failed to upload inventory. Please try again.");
        }
    } catch (error) {
        console.error("An error occured while uploading inventory.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.post("/update-inventory", upload.fields([
    { name: "featuredImage", maxCount: 1 },
    { name: "galleryImages", maxCount: 10 },
]), async (req, res) => {
    try {

        const {
            inventoryID, // must come from front-end
            condition, categoryID, type, make, model, offerType, driveType,
            transmission, fuelType, cylinders, color, doors, featureCategory,
            features, steering, title, price, description, tagline, year, hours,
            m3, sourceLink, overHeight, bankDetails,
            featuredImage, galleryImages
        } = req.body;

        // Featured Image Logic
        let featuredImageUrl = featuredImage || null;
        if (req.files["featuredImage"] && req.files["featuredImage"][0]) {
            featuredImageUrl = req.files["featuredImage"][0].path;
        }

        // Gallery Images Logic
        let galleryImageUrls = galleryImages || "";
        if (req.files["galleryImages"]) {
            const newGalleryUrls = req.files["galleryImages"].map(file => file.path);
            if (galleryImageUrls) {
                galleryImageUrls += "," + newGalleryUrls.join(",");
            } else {
                galleryImageUrls = newGalleryUrls.join(",");
            }
        }

        galleryImageUrls = galleryImageUrls.replace(/["']/g, '').replace(/,+/g, ',').replace(/^,|,$/g, ''); //added

        const query = `
            UPDATE Inventories SET
                Conditions = ?, Categories = ?, Types = ?, Makes = ?, Models = ?, Offer_Types = ?,
                Drive_Types = ?, Transmissions = ?, Fuel_Types = ?, Cylinders = ?, Colors = ?, Doors = ?,
                Features_Categories = ?, Features = ?, Steering = ?, Price = ?, Title = ?, Featured_Image = ?,
                Gallery_Images = ?, Description = ?, Tagline = ?, Year = ?, Hours = ?, M3 = ?, Source_Link = ?,
                Over_Height = ?, Bank = ?, Updated_At = NOW()
            WHERE ID = ?
        `;

        const values = [
            condition, categoryID, type, make, model, offerType, driveType,
            transmission, fuelType, cylinders, color, doors, featureCategory,
            features, steering, price, title, featuredImageUrl,
            galleryImageUrls, description, tagline, year, hours, m3,
            sourceLink, overHeight, bankDetails, inventoryID
        ];

        const [result] = await con.execute(query, values);
        if (result.affectedRows > 0) {
            return res.status(200).json(`Inventory updated successfully. ID: ${inventoryID}.`);
        } else {
            return res.status(404).json("No inventory found with the provided ID.");
        }
    } catch (error) {
        console.error("An error occurred while updating inventory:", error);
        return res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

const documents_storage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: "document_uploads",
        resource_type: "auto",
        type: "upload",
        format: async () => "pdf",
        public_id: (req, file) => Date.now() + "-" + file.originalname,
    },
});

const documents_upload = multer({ storage: documents_storage });

router.post(
    "/upload-docs",
    documents_upload.fields([
        { name: "BillOfLading", maxCount: 1 },
        { name: "ExportCancellationCertificate", maxCount: 1 },
        { name: "ExportCancellationCertificateJP", maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            const files = req.files;
            const reservationID = req.body.reservationID;

            if (!reservationID) {
                return res.status(400).json({ error: "Reservation ID is required." });
            }

            let setClauses = [];
            let values = [];
            let fileURLs = {
                BillOfLading: null,
                ExportCancellationCertificate: null,
                ExportCancellationCertificateJP: null,
            };

            if (files?.BillOfLading?.[0]) {
                fileURLs.BillOfLading = files.BillOfLading[0].path;
                setClauses.push("BillOfLading = ?");
                values.push(fileURLs.BillOfLading);
            }

            if (files?.ExportCancellationCertificate?.[0]) {
                fileURLs.ExportCancellationCertificate = files.ExportCancellationCertificate[0].path;
                setClauses.push("ExportCancellationCertificate = ?");
                values.push(fileURLs.ExportCancellationCertificate);
            }

            if (files?.ExportCancellationCertificateJP?.[0]) {
                fileURLs.ExportCancellationCertificateJP = files.ExportCancellationCertificateJP[0].path;
                setClauses.push("ExportCancellationCertificateJP = ?");
                values.push(fileURLs.ExportCancellationCertificateJP);
            }

            if (setClauses.length === 0) {
                return res.status(400).json({ error: "No valid documents uploaded." });
            }

            values.push(reservationID);

            const query = `UPDATE ReservedAndSoldInventories SET ${setClauses.join(", ")} WHERE ID = ?`;
            const [result] = await con.execute(query, values);

            res.status(200).json({
                message: "Files uploaded and saved to DB successfully.",
                urls: fileURLs,
            });
        } catch (error) {
            console.error("Error uploading documents:", error);
            res.status(500).json({ error: "Internal server error." });
        }
    }
);

module.exports = router;