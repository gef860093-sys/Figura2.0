import { createAntiSpamSystem } from '../../anti-spam';
import * as fc from 'fast-check';

describe('Anti-Spam System', () => {
  let logger: any;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  // Property 28: Auto-ban threshold
  it('should issue ban when violations reach threshold', async () => {
    const antiSpam = createAntiSpamSystem(null, {
      violationsBeforeBan: 3,
      violationWindowMs: 60000,
      banDurationMs: 900000,
      banExtensionMs: 900000,
      maxBanDurationMs: 86400000,
      banExpiryGraceMs: 60000,
    }, logger);

    const clientId = 'test-client';

    // Record violations
    await antiSpam.recordViolation(clientId);
    await antiSpam.recordViolation(clientId);
    await antiSpam.recordViolation(clientId);

    // Check if banned
    const bans = await antiSpam.listBans();
    expect(bans.length).toBeGreaterThan(0);
  });

  // Property 29: Banned client receives 403 with Retry-After
  it('should return 403 with Retry-After for banned client', async () => {
    const antiSpam = createAntiSpamSystem(null, {
      violationsBeforeBan: 1,
      violationWindowMs: 60000,
      banDurationMs: 900000,
      banExtensionMs: 900000,
      maxBanDurationMs: 86400000,
      banExpiryGraceMs: 60000,
    }, logger);

    const clientId = 'banned-client';
    await antiSpam.recordViolation(clientId);

    const middleware = antiSpam.middleware();
    const mockReq = {
      userInfo: { uuid: clientId },
      ip: '127.0.0.1',
    } as any;

    const mockRes = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    const mockNext = jest.fn();

    await middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  // Property 30: Ban extension with cap
  it('should extend ban but not exceed max duration', async () => {
    const antiSpam = createAntiSpamSystem(null, {
      violationsBeforeBan: 1,
      violationWindowMs: 60000,
      banDurationMs: 1000,
      banExtensionMs: 1000,
      maxBanDurationMs: 3000,
      banExpiryGraceMs: 60000,
    }, logger);

    const clientId = 'extend-test';
    await antiSpam.recordViolation(clientId);

    const bans1 = await antiSpam.listBans();
    const ban1 = bans1[0];

    // Record more violations
    await antiSpam.recordViolation(clientId);
    await antiSpam.recordViolation(clientId);

    const bans2 = await antiSpam.listBans();
    const ban2 = bans2[0];

    // Ban should be extended but not exceed max
    expect(ban2.expiresAt).toBeLessThanOrEqual(ban1.expiresAt + 3000);
  });

  // Property 32: Ban expiry cleanup
  it('should remove expired bans', async () => {
    const now = Date.now();
    jest.useFakeTimers({ now });

    const antiSpam = createAntiSpamSystem(null, {
      violationsBeforeBan: 1,
      violationWindowMs: 60000,
      banDurationMs: 1000,
      banExtensionMs: 900000,
      maxBanDurationMs: 86400000,
      banExpiryGraceMs: 100,
    }, logger);

    const clientId = 'expire-test';
    await antiSpam.recordViolation(clientId);

    let bans = await antiSpam.listBans();
    expect(bans.length).toBe(1);

    // Advance time past ban expiry + grace period
    jest.setSystemTime(now + 2000);

    // listBans() does lazy expiry check — expired bans are filtered out
    bans = await antiSpam.listBans();
    expect(bans.length).toBe(0);

    jest.useRealTimers();
  });
});
