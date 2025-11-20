require('dotenv').config();
const express = require('express'),
    http = require('http'),
    cors = require('cors'),
    bodyParser = require('body-parser'),
    authenticateToken = require("./authenticateToken"),
    hr = require('./routes/hr'),
    admin = require('./routes/administrator'),
    attendance = require('./routes/attendance'),
    general = require('./routes/general'),
    invoice = require('./routes/invoice'),
    auth = require('./routes/auth'),

    { verifyToken } = require('./authMiddleware'),
    
    app = express(),
    server = http.createServer(app)
    ;

const allowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5500/',
    'https://crm.a-techsolutionz.com',
];

// app.use(cors());
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        } else {
            return callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json());

app.use("/auth", auth);
app.use(authenticateToken);

app.use('/hr', hr);
app.use('/admin', admin);
app.use('/attendance', attendance);
app.use('/invoice', invoice);
app.use('/general', general);

app.get('*', function (req, res) {
    // console.log('This is requested URL: ' + req.url);
    res.status(404).json('API not found.');
});

server.listen(300 || process.env.PORT, () => { })