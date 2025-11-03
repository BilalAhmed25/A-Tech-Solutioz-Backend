const express = require('express'),
path = require('path'),
bodyParser = require('body-parser'),



{ con } = require('../database'),

router = express.Router();

router.get('/', function (req, res) {
    res.sendFile(path.join(__dirname,'../views/administrator/studentDashboard.html'))
})

module.exports = router;