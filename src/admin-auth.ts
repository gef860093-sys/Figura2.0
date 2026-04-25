/**
 * Admin API Key Auth middleware
 * รองรับ: Authorization: Bearer <key>, X-Admin-Key: <key>, ?pass=<key> (backward compat)
 */
import { Request, Response, NextFunction } from 'express';

export function createAdminAuth() {
  const adminKey = process.env.ADMIN_API_KEY || process.env.DASHBOARD_PASS || 'admin123';

  return function adminAuth(req: Request, res: Response, next: NextFunction) {
    const fromBearer = req.headers['authorization']?.replace('Bearer ', '').trim();
    const fromHeader = req.headers['x-admin-key'] as string | undefined;
    const fromQuery = req.query.pass as string | undefined;

    const provided = fromBearer || fromHeader || fromQuery;

    if (!provided || provided !== adminKey) {
      return res.status(403).json({ error: 'Unauthorized — provide Admin API key via Authorization header or X-Admin-Key' });
    }
    next();
  };
}
