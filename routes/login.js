const express = require('express'),
    path = require('path'),
    bodyParser = require('body-parser'),
    { con } = require('../database'),
    jwt = require('jsonwebtoken'),
    { verifyToken } = require('../authMiddleware'),
    router = express.Router();

router.use(express.json());
router.use(bodyParser.urlencoded({ extended: true }));

router.get('/', verifyToken, function (req, res) {
    if (req.user.Type != undefined && req.user.Type == 'Student') {
        res.redirect('/student-dashboard')
    }
    else {
        res.redirect('/dashboard')
    }
    // res.sendFile(path.join(__dirname, '../views/sign-in.html'))
})

module.exports = router;