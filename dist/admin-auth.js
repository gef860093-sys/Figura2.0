"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdminAuth = createAdminAuth;
function createAdminAuth() {
    const adminKey = process.env.ADMIN_API_KEY || process.env.DASHBOARD_PASS || 'admin123';
    return function adminAuth(req, res, next) {
        const fromBearer = req.headers['authorization']?.replace('Bearer ', '').trim();
        const fromHeader = req.headers['x-admin-key'];
        const fromQuery = req.query.pass;
        const provided = fromBearer || fromHeader || fromQuery;
        if (!provided || provided !== adminKey) {
            return res.status(403).json({ error: 'Unauthorized — provide Admin API key via Authorization header or X-Admin-Key' });
        }
        next();
    };
}
//# sourceMappingURL=admin-auth.js.map