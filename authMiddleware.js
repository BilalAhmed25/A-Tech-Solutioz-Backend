const jwt = require('jsonwebtoken');
const secretKey = process.env.SECRET_KEY;

// Middleware to verify the JWT token
const verifyToken = (allowedRoles = []) => {

    return (req, res, next) => {
        const token = req.headers['authorization'];
        if (!token) return res.status(401).json({
            "status": "error",
            "error": {
                "code": "NO_TOKEN_PROVIDED",
                "message": "Access Denied: No Token Provided."
            }
        });

        jwt.verify(token, secretKey, (err, decodedToken) => {
            if (err) {
                if (err instanceof jwt.TokenExpiredError) return res.status(403).json("Token is expired. Please re-login to continue.");
                else if (err instanceof jwt.JsonWebTokenError) return res.status(401).json("You are not authorized.");
                else return res.status(401).json("You are not authorized.");
            }

            req.user = decodedToken;
            const userType = req.user?.UserType;
            const roles = Array.isArray(userType) ? userType : [userType];

            // if (roles.includes("Admin") || roles.includes("Editor")) {
            //     return next();
            // }

            const hasAccess = roles.some(role => allowedRoles.includes(role));
            if (hasAccess) {
                return next();
            }

            return res.status(403).send('Unauthorized: No Access to Module');
        });
    }
};

module.exports = {
    verifyToken
};