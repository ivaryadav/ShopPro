'use strict';

const { AuthorizationError } = require('../errors');

function requirePermission(code) {
  return function (req, res, next) {
    const perms = (req.platformUser && req.platformUser.permissions) || [];
    if (!perms.includes(code)) return next(new AuthorizationError(`Missing permission: ${code}`));
    next();
  };
}

module.exports = { requirePermission };
