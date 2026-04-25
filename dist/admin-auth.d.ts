/**
 * Admin API Key Auth middleware
 * รองรับ: Authorization: Bearer <key>, X-Admin-Key: <key>, ?pass=<key> (backward compat)
 */
import { Request, Response, NextFunction } from 'express';
export declare function createAdminAuth(): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=admin-auth.d.ts.map