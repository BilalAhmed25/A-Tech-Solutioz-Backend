const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(403).json({ message: "Authorization header missing" });
    }

    // The token is usually in the format: "Bearer <token>"
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(403).json({ message: "Token missing from Authorization header" });
    }
    
    jwt.verify(token, process.env.SECRET_KEY, (err, user) => {
        if (err) {
            return res.status(401).json({ message: "Invalid or expired token" });
        }

        // Attach user info from token to the request object
        req.user = user;
        next();
    });
}

module.exports = authenticateToken;