const path = require('path');

function checkAccess(parentModuleID, subModuleID, next) {
    return function (req, res, next) {
        const userPermissions = req.user?.access;
        const hasAccess = userPermissions?.some(permission =>
            permission.ModuleID === parentModuleID && permission.SubModuleID.includes(subModuleID)
        );

        if (hasAccess) {
            next();
        } else {
            res.status(403).send('Access denied');
        }
    }
}

module.exports = checkAccess;