const mysql = require('mysql2/promise');
// const mariadb = require('mariadb');

const con = mysql.createPool({
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,

    connectionLimit: 100,
    connectTimeout: 10000,
    // multipleStatements: true
});

const attendanceDB = mysql.createPool({
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.ATTENDANCE_DATABASE_NAME,
    connectionLimit: 100,
});

module.exports = {
    con,
    attendanceDB,
};