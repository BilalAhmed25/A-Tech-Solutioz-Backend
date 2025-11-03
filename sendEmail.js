const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

async function sendEmail(from, to, subject, emailBody, attachments = [], configuration) {
    let htmlContent = `<>Internal server error.</>`;
    const transporter = nodemailer.createTransport(configuration);
    const mailOptions = {
        from,
        to,
        subject,
        html: emailBody || htmlContent,
        priority: 'high',
        attachments,
    };

    await transporter.sendMail(mailOptions);
}

module.exports = sendEmail;
