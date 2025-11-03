var express = require('express'),
    router = express.Router(),
    jwt = require('jsonwebtoken'),
    { con } = require('../database');

router.post('/login', async function (req, res) {
    const { email, password } = req.body;
    const query = "SELECT `UserDetails`.*, `Designations`.DesignationTitle, `Designations`.Access FROM `UserDetails` JOIN `Designations` ON `UserDetails`.DesignationID = `Designations`.ID WHERE Email = ? AND Password = ? LIMIT 1";
    try {
        const [result] = await con.execute(query, [email, password]);
        if (result.length === 0) {
            return res.status(401).json("Incorrect email or password.");
        }

        const user = result[0];
        if (user.Status !== 'Active') {
            return res.status(401).json(`Your service status is ${user.Status}. Please contact support.`);
        }

        const { Password, ...userData } = user;
        const token = jwt.sign(userData, process.env.SECRET_KEY, { expiresIn: '10h' });
        res.status(200).json({ token });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

router.post('/sign-up', async function (req, res) {
    const { name, email, phone, password, departmentId, designationId, residentialAddress, languages, accountType, status } = req.body;
    try {
        const checkUserQuery = "SELECT * FROM UserDetails WHERE Email = ?";
        const [existingUsers] = await con.execute(checkUserQuery, [email]);

        if (existingUsers.length > 0) {
            return res.status(409).json("User with this email already exists.");
        }

        const insertUserQuery = `INSERT INTO UserDetails (Name, Email, Phone, Password, DepartmentID, DesignationID, ResidentialAddress, Languages, AccountType, Status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await con.execute(insertUserQuery, [name, email, phone, password, departmentId, designationId, residentialAddress, languages, accountType, status]);
        res.status(201).json("User registered successfully.");

    } catch (error) {
        console.error("Signup error:", error);
        res.status(500).json("Internal server error. Please try again later.");
    }
})

module.exports = router;