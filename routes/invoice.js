const express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    nodemailer = require('nodemailer'),
    fs = require('fs'),
    cloudinary = require("../cloudinaryConfig"),
    multer = require("multer"),
    router = express.Router();

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const DOMAIN = 'http://localhost:300';
// const DOMAIN = 'https://api.expertcodecraft.com';

const { con } = require('../database');
const sendEmail = require('../sendEmail');
router.use(bodyParser.urlencoded({ extended: true }));

router.get('/get-invoicing-history', async function (req, res) {
    try {
        const { empID } = req.query;
        let query = "SELECT * FROM `Invoices` JOIN `ClientDetails` ON `Invoices`.`ClientID` = `ClientDetails`.ID";
        const params = [];
        if (empID) {
            query += " WHERE `Invoices`.CreatedBy = ?";
            params.push(empID);
        }
        query += " ORDER BY `Invoices`.InvoiceID DESC;";
        const [result] = await con.execute(query, params);
        res.json(result);
    } catch (err) {
        console.error("Error getting project invoices:", err);
        res.status(500).json("Internal server error. Please try again later.");
    }
});

const upload = multer({ storage: multer.memoryStorage() });
router.post('/upload-invoice', upload.single('pdfFile'), async function (req, res) {
    const { brandID, clientID, clientName, clientEmail, servicesAvailed, invoiceParticulars, invoiceDate, invoiceNote, createdBy, orderID, orderTitle } = req.body;
    try {
        let finalOrderID = orderID;
        console.log(invoiceParticulars)
        // If it's a new order, insert into Orders first
        if (orderID === 'new') {
            const [orderResult] = await con.execute(`INSERT INTO Orders (ClientID, Title, ServicesAvailed, CreatedBy) VALUES (?, ?, ?, ?)`,
                [clientID, orderTitle, servicesAvailed, createdBy]
            );
            finalOrderID = orderResult.insertId;
        }

        // Upload PDF to Cloudinary
        const fileName = `Invoice-${finalOrderID}-${Date.now()}`;
        const invoiceUrl = await uploadFileToCloudinary(req.file.buffer, fileName);

        // Insert invoice record
        const [invoiceResult] = await con.execute(
            `INSERT INTO Invoices (BrandID, OrderID, ClientID, InvoiceParticulars, InvoiceDate, InvoiceNote, CreatedBy, InvoiceFileURL) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [brandID, finalOrderID, clientID, invoiceParticulars, invoiceDate, invoiceNote, createdBy, invoiceUrl,]
        );

        // Load email template
        const templatePath = path.join(__dirname, '../email-templates/invoice-template.html');
        let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
        htmlTemplate = htmlTemplate.replace('{{clientName}}', clientName);
        htmlTemplate = htmlTemplate.replace('{{services}}', servicesAvailed || '');
        htmlTemplate = htmlTemplate.replace('{{invoicePayURL}}', `${DOMAIN}/invoice/pay-invoice/${invoiceResult.insertId}`);

        // Send email
        await sendEmail(
            `"Expert Code Craft" <${process.env.SMTP_USER}>`,
            clientEmail,
            'Your Invoice from Expert Code Craft - INV #' + finalOrderID,
            htmlTemplate,
            [
                {
                    filename: 'logo.png',
                    path: path.join(__dirname, '../email-templates/images/exper-code-craft.png'),
                    cid: 'logo'
                },
                {
                    filename: 'bg.png',
                    path: path.join(__dirname, '../email-templates/images/ecc-email-bg.png'),
                    cid: 'bg'
                },
                {
                    filename: 'invoice.pdf',
                    path: invoiceUrl
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

        res.status(200).json({
            message: orderID === 'new'
                ? "Order and Invoice created successfully"
                : "Invoice created successfully",
            fileUrl: invoiceUrl,
            invoiceId: invoiceResult.insertId,
            orderId: finalOrderID
        });

    } catch (error) {
        console.error("Error uploading invoice.", error);
        res.status(500).json({ error: "Internal server error. Please try again later." });
    }
});

router.get('/pay-invoice/:invoiceID', async (req, res) => {
    const invoiceID = req.params.invoiceID;

    try {
        const [invoices] = await con.execute('SELECT * FROM Invoices WHERE InvoiceID = ?', [invoiceID]);

        if (invoices.length === 0) {
            return res.status(404).send('Invoice not found');
        }

        const invoice = invoices[0];
        if (invoice.Status === 'Voided') {
            const templatePath = path.join(__dirname, '../messages/voided.html');
            const amountDue = invoice.InvoiceParticulars.reduce((total, item) => total + (item.price * item.quantity), 0);
            const formattedDate = new Date(invoice.CreatedAt).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            let htmlContent = fs.readFileSync(templatePath, 'utf8');
            htmlContent = htmlContent
                .replace('{{invoiceID}}', invoice.InvoiceID)
                .replace('{{dated}}', formattedDate)
                .replace('{{amountDue}}', amountDue.toFixed(2));

            return res.send(htmlContent);
        } else if (invoice.Status === 'Paid') {
            const templatePath = path.join(__dirname, '../messages/invoice-paid.html');
            const amountDue = invoice.InvoiceParticulars.reduce((total, item) => total + (item.price * item.quantity), 0);
            const formattedDate = new Date(invoice.CreatedAt).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            let htmlContent = fs.readFileSync(templatePath, 'utf8');
            htmlContent = htmlContent
                .replace('{{invoiceID}}', invoice.InvoiceID)
                .replace('{{transationID}}', invoice?.TransactionID)
                .replace('{{dated}}', formattedDate)
                .replace('{{amountDue}}', amountDue.toFixed(2));

            return res.send(htmlContent);
        }

        // Parse particulars
        let particulars = invoice.InvoiceParticulars;
        if (typeof particulars === 'string') {
            try {
                particulars = JSON.parse(particulars);
            } catch (e) {
                console.error('Failed to parse InvoiceParticulars:', e);
                return res.status(500).send('Invalid invoice particulars format');
            }
        }

        if (!Array.isArray(particulars) || particulars.length === 0) {
            return res.status(400).send('Invoice has no valid items to charge');
        }

        // 🔄 Map to Stripe line_items with service names
        const line_items = await Promise.all(
            particulars.map(async (item) => {
                try {
                    // Fetch service name from ProjectTypes using serviceId
                    const [rows] = await con.execute(
                        'SELECT ProjectType FROM ProjectTypes WHERE ID = ?',
                        [item.serviceId]
                    );

                    const serviceName = rows.length > 0 ? rows[0].ProjectType : `Service ID: ${item.serviceId}`;

                    return {
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: `Service: ${serviceName}`,
                            },
                            unit_amount: Math.round(item.price * 100),
                        },
                        quantity: item.quantity,
                    };
                } catch (err) {
                    console.error('Error fetching ProjectType for serviceId:', item.serviceId, err);
                    throw new Error('Failed to build line items');
                }
            })
        );

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items,
            success_url: `${DOMAIN}/invoice/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/invoice/payment-cancelled?session_id={CHECKOUT_SESSION_ID}`,
            metadata: {
                invoiceID: invoice.InvoiceID.toString(),
                clientName: invoice.ClientName,
            },
            customer_email: invoice.ClientEmail,
        });

        res.redirect(303, session.url);
    } catch (err) {
        console.error("Error creating Stripe session:", err);
        res.status(500).send("Something went wrong");
    }
});

function getPublicIdFromUrl(url) {
    const parts = url.split('/');
    const fileWithExt = parts.pop(); // "INV-001.pdf"
    const folder = parts.pop(); // "invoices"
    const fileName = fileWithExt.replace(/\.[^/.]+$/, ""); // "INV-001"
    return `${folder}/${fileName}`;
}

const updateInvoiceToPaid = async (pdfUrl) => {
    // Step 1: Download PDF
    const existingPdfBytes = await fetch(pdfUrl).then(res => res.arrayBuffer());

    // Step 2: Load PDF
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Step 3: Load PAID stamp image from backend
    const paidImagePath = path.join(__dirname, '../email-templates/images/paid.jpg');
    const paidImageBytes = fs.readFileSync(paidImagePath);
    const paidImage = await pdfDoc.embedJpg(paidImageBytes);

    // Step 4: Modify first page (adjust position for your layout)
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];

    // Original "unpaid" stamp was at X=155, Y=70, width=40
    const stampWidth = 40;
    const stampHeight = stampWidth * (paidImage.height / paidImage.width);

    // Step 5: Draw PAID stamp at the same position
    firstPage.drawText('PAID', {
        x: 155,
        y: 70,
        width: stampWidth,
        height: stampHeight,
        opacity: 1
    });

    // Step 6: Save updated PDF
    const updatedPdfBytes = await pdfDoc.save();

    // Step 7: Upload to Cloudinary
    const invoideID = getPublicIdFromUrl(invoiceURL);
    const tempFilePath = `/tmp/paid-invoice-${invoideID}.pdf`;
    fs.writeFileSync(tempFilePath, updatedPdfBytes);

    const uploadResult = await cloudinary.uploader.upload(tempFilePath, {
        resource_type: 'raw',
        public_id: invoideID,
        overwrite: true
    });

    // Step 8: Clean up temp file
    fs.unlinkSync(tempFilePath);
    return uploadResult.secure_url;
}

const sendConfirmationEmail = async (email, invoiceID, transactionID, totalAmount, invoiceURL) => {
    // Load email template
    const currentDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const templatePath = path.join(__dirname, '../email-templates/payment-confirmation.html');
    let htmlTemplate = fs.readFileSync(templatePath, 'utf-8');
    htmlTemplate = htmlTemplate.replace('{{invoiceID}}', invoiceID);
    htmlTemplate = htmlTemplate.replace('{{transactionID}}', transactionID);
    htmlTemplate = htmlTemplate.replace('{{dated}}', currentDate);
    htmlTemplate = htmlTemplate.replace('{{totalAmount}}', totalAmount);
    htmlTemplate = htmlTemplate.replace('{{invoiceURL}}', invoiceURL);

    // Send email with invoice attachment (if you want to attach, or just include the link)
    await sendEmail(
        `"Expert Code Craft" <${process.env.SMTP_USER}>`,
        email,
        'Payment confirmation from Expert Code Craft',
        htmlTemplate,
        [
            {
                filename: 'logo.png',
                path: path.join(__dirname, '../email-templates/images/exper-code-craft.png'),
                cid: 'logo'
            },
            {
                filename: `Invoice-${invoiceID}.pdf`,
                path: invoiceURL
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

    return true;
}

// Add this to your main Express app (e.g., app.js)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const endpointSecret = 'whsec_...'; // Webhook secret from Stripe Dashboard
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle payment success
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const invoiceID = session.metadata.invoiceID;

        try {
            // Retrieve invoice data
            const [invoiceRows] = await con.execute(
                'SELECT TotalAmount, InvoiceURL FROM Invoices WHERE InvoiceID = ?',
                [invoiceID]
            );

            if (!invoiceRows.length) {
                console.error(`Invoice not found: ${invoiceID}`);
                return res.status(404).send('Invoice not found');
            }

            const totalAmount = invoiceRows[0].TotalAmount;
            const invoiceURL = invoiceRows[0].InvoiceURL;
            const newURL = await updateInvoiceToPaid(invoiceURL, invoiceID);

            await con.execute('UPDATE Invoices SET Status = ?, TransactionID = ?, InvoiceFileURL = ? WHERE InvoiceID  = ?', [
                'Paid',
                session.payment_intent,
                newURL,
                invoiceID
            ]);

            // Send confirmation email (you can use nodemailer or any service)
            await sendConfirmationEmail(session.customer_email, invoiceID, session.payment_intent, totalAmount, newURL);
        } catch (err) {
            console.error("Failed to update invoice or send email:", err);
        }
    }

    res.status(200).send();
});

router.get('/payment-success', async (req, res) => {
    const session_id = req.query.session_id;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const invoiceID = session.metadata.invoiceID;
        const [rows] = await con.execute('SELECT Status, TransactionID, TotalAmount, InvoiceFileURL FROM Invoices WHERE InvoiceID = ?', [invoiceID]);
        if (!rows.length) {
            return res.status(404).send('Invoice not found');
        }
        const invoice = rows[0];
        res.redirect(invoice.InvoiceFileURL);
    } catch (err) {
        console.error('Error retrieving payment success data:', err);
        res.status(500).send('Error retrieving payment status.');
    }
});

router.get('/payment-cancelled', async (req, res) => {
    const session_id = req.query.session_id;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const invoiceID = session.metadata.invoiceID;
        await con.execute(`UPDATE Invoices SET Status = ? WHERE InvoiceID = ?`, ['Cancelled', invoiceID]);
        res.send(`Payment cancelled or failed for Invoice ID: ${invoiceID}`);
    } catch (err) {
        console.error('Error retrieving or updating cancelled session:', err);
        res.status(500).send('Error processing cancelled payment.');
    }
});

router.get('/get-order-and-invoices', async (req, res) => {
    const { clientID } = req.query;
    try {
        const [rows] = await con.execute(`SELECT o.ID AS OrderID, o.ClientID, i.InvoiceID, i.OrderID, i.InvoiceParticulars, i.InvoiceDate,i.InvoiceFileURL, i.Status FROM Orders o LEFT JOIN Invoices i ON o.ID = i.OrderID WHERE o.ClientID = ? ORDER BY o.ID DESC, i.InvoiceID DESC`, [clientID]);
        const result = [];
        const orderMap = {};
        rows.forEach(row => {
            if (row.OrderID === null) {
                return; // Skip if order doesn't exist
            }

            if (!orderMap[row.OrderID]) {
                orderMap[row.OrderID] = {
                    OrderID: row.OrderID,
                    ClientID: row.ClientID,
                    Invoices: []
                };
                result.push(orderMap[row.OrderID]);
            }
            if (row.InvoiceID) {
                orderMap[row.OrderID].Invoices.push({
                    InvoiceID: row.InvoiceID,
                    Amount: row.InvoiceParticulars,
                    InvoiceDate: row.InvoiceDate,
                    InvoiceFileURL: row.InvoiceFileURL, 
                    Status: row.Status
                });
            }
        });
        res.json(result);
    } catch (err) {
        console.error('Error getting orders and invoices: ', err);
        res.status(500).send('Error getting orders and invoices.');
    }
});

router.put('/void-invoice', async (req, res) => {
    let { invoiceID } = req.body;

    try {
        const [invoiceRows] = await con.execute('SELECT Status FROM Invoices WHERE InvoiceID = ?', [invoiceID]);
        if (invoiceRows.length === 0) {
            return res.status(404).json({ message: 'Invoice not found.' });
        }

        if (invoiceRows[0].Status === 'Paid') {
            return res.status(400).json({ message: 'Cannot void a paid invoice.' });
        }

        const [result] = await con.execute('UPDATE Invoices SET Status = ? WHERE InvoiceID = ?', ['Voided', invoiceID]);
        res.json({ message: 'Invoice has been voided successfully.', affectedRows: result.affectedRows });
    } catch (error) {
        console.error('Error voiding invoice:', error);
        res.status(500).json({ message: 'Error voiding invoice.' });
    }
});

router.put('/void-invoice-old', async (req, res) => {
    let { invoiceID } = req.body;
    try {
        const sql = 'UPDATE Invoices SET Status = ? WHERE InvoiceID = ?';
        const [result] = await con.execute(sql, ['Voided', invoiceID]);
        res.json({ message: 'Invoice has been voided successfully.', affectedRows: result.affectedRows });
    } catch (error) {
        console.error('Error voiding invoice.', error);
        res.status(500).json({ message: 'Error voiding invoice.' });
    }
});

module.exports = router;