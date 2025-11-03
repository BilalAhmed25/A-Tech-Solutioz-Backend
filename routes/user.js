var express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    router = express.Router();

const { con } = require('../database');
router.use(bodyParser.urlencoded({ extended: true }));
router.get('/get-favourites', async function (req, res) {
    // const query = "SELECT * FROM Favourites";
    let query = `SELECT 
    Inventories.ID, Inventories.Features, Inventories.Price, Inventories.Title, Inventories.Featured_Image, Inventories.Gallery_Images, Inventories.Description, Inventories.Tagline, Inventories.Year, Inventories.Hours, Inventories.M3, Inventories.Source_Link, Inventories.Over_Height, Inventories.Created_At, Inventories.Updated_At, Inventories.Created_By,
    InventoryCategories.InventoryCategory,
    InventoryTypes.InventoryType,
    InventoryMakes.InventoryMake,
    InventoryModels.InventoryModel,
    Cond.Value AS ConditionName,
    OfferTypes.Value AS OfferTypeName,
    DriveType.Value AS DriveTypeName,
    Transmissions.Value AS TransmissionName,
    FuelType.Value AS FuelTypeName,
    Cylinders.Value AS CylindersName,
    Colors.Value AS ColorName,
    Doors.Value AS DoorsName,
    FeaturesCategories.Value AS FeatureCategoryName,
    Steering.Value AS SteeringName,
    Bank.BeneficiaryName, Bank.BankName, Bank.IBANNumber, Bank.AccountNumber, Bank.BankAddress, Bank.Currency, Bank.SwiftCode
    FROM Inventories
    JOIN InventoryCategories 
        ON Inventories.Categories = InventoryCategories.ID
    JOIN InventoryTypes 
        ON Inventories.Types = InventoryTypes.ID
    JOIN InventoryMakes 
        ON Inventories.Makes = InventoryMakes.ID
    JOIN InventoryModels 
        ON Inventories.Models = InventoryModels.ID
    JOIN Favourites
        ON Favourites.InventoryID = Inventories.ID

    JOIN InventoryDropdownValues AS Cond 
        ON Cond.ID = Inventories.Conditions AND Cond.ValueType = 'Condition'
    JOIN InventoryDropdownValues AS OfferTypes 
        ON OfferTypes.ID = Inventories.Offer_Types AND OfferTypes.ValueType = 'OfferType'
    JOIN InventoryDropdownValues AS DriveType 
        ON DriveType.ID = Inventories.Drive_Types AND DriveType.ValueType = 'DriveType'
    JOIN InventoryDropdownValues AS Transmissions 
        ON Transmissions.ID = Inventories.Transmissions AND Transmissions.ValueType = 'Transmission'
    JOIN InventoryDropdownValues AS FuelType 
        ON FuelType.ID = Inventories.Fuel_Types AND FuelType.ValueType = 'FuelType'
    JOIN InventoryDropdownValues AS Cylinders 
        ON Cylinders.ID = Inventories.Cylinders AND Cylinders.ValueType = 'Cylinders'
    JOIN InventoryDropdownValues AS Colors 
        ON Colors.ID = Inventories.Colors AND Colors.ValueType = 'Colors'
    JOIN InventoryDropdownValues AS Doors 
        ON Doors.ID = Inventories.Doors AND Doors.ValueType = 'Doors'
    JOIN InventoryDropdownValues AS Steering 
        ON Steering.ID = Inventories.Steering AND Steering.ValueType = 'Steering'
    JOIN InventoryDropdownValues AS FeaturesCategories 
        ON FeaturesCategories.ID = Inventories.Features_Categories AND FeaturesCategories.ValueType = 'FeatureCategories'

    JOIN BankDetails AS Bank 
        ON Bank.ID = Inventories.Bank

    WHERE Inventories.Status = 'Approved'
    AND Favourites.UserID = ?`;

    const { userID } = req.query;

    try {
        const [result] = await con.execute(query, [userID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting favourites.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/add-to-favourites', async function (req, res) {
    const query = "INSERT INTO `Favourites`(`UserID`, `InventoryID`) VALUES (?,?);";
    const { userID, inventoryID } = req.body;
    try {
        const [result] = await con.execute(query, [userID, inventoryID]);
        res.status(200).json('Successsfully added to favourite.');
    } catch (error) {
        console.error("An error occured while adding to favourites.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-inquiries', async function (req, res) {
    let query = "SELECT `InquirySubmissions`.*, `InquirySubmissions`.ID AS 'InquiryID', Inventories.Title, Inventories.Featured_Image, Inventories.Description, Inventories.Price FROM `InquirySubmissions` JOIN Inventories ON InquirySubmissions.InventoryID = Inventories.ID";
    const { userID } = req.query;
    if (userID) {
        query += " WHERE InquirySubmissions.RequestedBy = ?;";
    }
    try {
        const [result] = await con.execute(query, [userID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting inquiry requests.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.get('/get-reserved-inventories', async function (req, res) {
    let query = "SELECT UserDetails.Name, UserDetails.Phone, UserDetails.Email, `ReservedAndSoldInventories`.ID AS 'ReservationID', `ReservedAndSoldInventories`.ConsigneeID, ReservedAndSoldInventories.Status AS 'CurrentStatus', ReservedAndSoldInventories.ReservedBy, ReservedAndSoldInventories.DestinationCountry, ReservedAndSoldInventories.DestinationCity, ReservedAndSoldInventories.DateTime, ReservedAndSoldInventories.InventoryPrice, ReservedAndSoldInventories.InspectionAmount, ReservedAndSoldInventories.FreightRate, ReservedAndSoldInventories.TotalPayment, ReservedAndSoldInventories.Discount, ReservedAndSoldInventories.AuctionSheet, ReservedAndSoldInventories.BillOfLading, ReservedAndSoldInventories.ExportCancellationCertificate, ReservedAndSoldInventories.ExportCancellationCertificate, ReservedAndSoldInventories.Quantity, ConsigneeDetails.Name AS 'ConsigneeName', ConsigneeDetails.Email AS 'ConsigneeEmail', ConsigneeDetails.Phone AS 'ConsigneePhone', ConsigneeDetails.NotificationPhone, ConsigneeDetails.NotificationEmail, ConsigneeDetails.ResidentialAddress, ConsigneeDetails.PostalAddress, Inventories.*, BankDetails.BeneficiaryName, BankDetails.BankName, BankDetails.IBANNumber, BankDetails.AccountNumber, BankDetails.BankAddress, BankDetails.Currency, BankDetails.SwiftCode FROM `ReservedAndSoldInventories` JOIN Inventories ON ReservedAndSoldInventories.InventoryID = Inventories.ID JOIN UserDetails ON UserDetails.UserID = ReservedAndSoldInventories.ReservedBy JOIN BankDetails ON ReservedAndSoldInventories.BankID = BankDetails.ID LEFT JOIN ConsigneeDetails ON ReservedAndSoldInventories.ConsigneeID = ConsigneeDetails.ID";
    const { userID, type } = req.query;
    if (type == 'Sold') {
        query += " WHERE ReservedAndSoldInventories.Status = 'Sold'";
    } else {
        query += " WHERE ReservedAndSoldInventories.Status != 'Sold'";
    }
    if (userID) {
        query += " AND ReservedAndSoldInventories.ReservedBy = ?;";
    }
    try {
        const [result] = await con.execute(query, [userID]);
        res.status(200).json(result);
    } catch (error) {
        console.error("An error occured while getting details.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/submit-inquiry', async function (req, res) {
    const query = "INSERT INTO `InquirySubmissions`(`InventoryID`, `Name`, `Email`, `Phone`, `DestinationCountry`, `DestinationCity`, `RequestedBy`) VALUES (?, ?, ?, ?, ?, ?, ?);";
    const { userID, name, email, phone, destinationCountry, destinationCity, inventoryID } = req.body;

    try {
        const [result] = await con.execute(query, [inventoryID, name, email, phone, destinationCountry, destinationCity, userID]);
        res.status(200).json('Successsfully uploaded inquiry request.');
    } catch (error) {
        console.error("An error occured while uploading inquiry request.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/add-consignee', async function (req, res) {
    const query = "INSERT INTO `ConsigneeDetails`(`UserID`, `Name`, `Phone`, `NotificationPhone`, `Email`, `NotificationEmail`, `Country`, `ResidentialAddress`, `PostalAddress`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);";
    const { userID, consigneeID, name, phone, notificationPhone, email, notificationEmail, country, residentialAddress, postalAddress } = req.body;

    try {
        const [result] = await con.execute(query, [userID, name, phone, notificationPhone, email, notificationEmail, country, residentialAddress, postalAddress]);
        res.status(200).json('Successsfully added new consignee.');
    } catch (error) {
        console.error("An error occured while adding consignee.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/update-consignee', async function (req, res) {
    const query = "UPDATE `ReservedAndSoldInventories` SET ConsigneeID = ? WHERE ID = ?;";
    const { consigneeID, reservationID } = req.body;

    if (!consigneeID || !reservationID) {
        res.status(404).json('Please provide all required data.');
        return;
    }

    try {
        const [result] = await con.execute(query, [consigneeID, reservationID]);
        res.status(200).json('Successsfully updated consignee.');
    } catch (error) {
        console.error("An error occured while updating consignee.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.post('/reserve-inventory', async function (req, res) {
    const query = "INSERT INTO `ReservedAndSoldInventories`(`ReservedBy`, `InventoryID`, `DestinationCountry`, `DestinationCity`, `InventoryPrice`, `DownPayment`, `InspectionAmount`, `FreightRate`, `TotalPayment`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);";
    const { userID, destinationCountry, destinationCity, inventoryID, inventoryPrice, downPayment, inspectionAmount, freightRate, totalPayment } = req.body;

    try {
        const [result] = await con.execute(query, [userID, inventoryID, destinationCountry, destinationCity, inventoryPrice, downPayment, inspectionAmount, freightRate, totalPayment]);
        res.status(200).json('Successsfully reserved inventory.');
    } catch (error) {
        console.error("An error occured while reserving inventory.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

router.delete('/delete-from-favourites', async function (req, res) {
    const query = "DELETE FROM `Favourites` WHERE `UserID` = ? AND `InventoryID` = ?;";
    const { userID, inventoryID } = req.query;
    try {
        const [result] = await con.execute(query, [userID, inventoryID]);
        res.status(200).json('Successsfully deleted from favourite.');
    } catch (error) {
        console.error("An error occured while adding to favourites.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
})

module.exports = router;
