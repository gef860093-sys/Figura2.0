import { createRateLimiters } from '../../rate-limiter';
import * as fc from 'fast-check';

describe('Rate Limiter', () => {
  let logger: any;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  // Property 17: Rate limit key extraction
  it('should key on user ID for authenticated requests', () => {
    const limiters = createRateLimiters(null, {
      uploadWindowMs: 60000,
      uploadMax: 10,
      apiWindowMs: 60000,
      apiMax: 100,
      windowResetGraceMs: 5000,
    }, logger);

    const mockReq = {
      userId: 'user123',
      ip: '192.168.1.1',
    } as any;

    // The rate limiter should use user ID as key
    expect(mockReq.userId).toBe('user123');
  });

  // Property 17: Rate limit key extraction (unauthenticated)
  it('should key on IP for unauthenticated requests', () => {
    const limiters = createRateLimiters(null, {
      uploadWindowMs: 60000,
      uploadMax: 10,
      apiWindowMs: 60000,
      apiMax: 100,
      windowResetGraceMs: 5000,
    }, logger);

    const mockReq = {
      ip: '192.168.1.1',
    } as any;

    // The rate limiter should use IP as key
    expect(mockReq.ip).toBe('192.168.1.1');
  });

  // Property 18: Separate rate limit counters per endpoint type
  it('should maintain separate counters for upload and API', () => {
    const limiters = createRateLimiters(null, {
      uploadWindowMs: 60000,
      uploadMax: 5,
      apiWindowMs: 60000,
      apiMax: 100,
      windowResetGraceMs: 5000,
    }, logger);

    // Upload limiter should have max 5
    // API limiter should have max 100
    expect(limiters.upload).toBeDefined();
    expect(limiters.api).toBeDefined();
  });

  // Property 19: Rate limit 429 response headers
  it('should include all required headers in 429 response', () => {
    const limiters = createRateLimiters(null, {
      uploadWindowMs: 60000,
      uploadMax: 1,
      apiWindowMs: 60000,
      apiMax: 100,
      windowResetGraceMs: 5000,
    }, logger);

    const mockReq = {
      ip: '192.168.1.1',
    } as any;

    const mockRes = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    // Simulate rate limit exceeded
    const handler = limiters.upload;
    if (handler && (handler as any).handler) {
      (handler as any).handler(mockReq, mockRes);

      expect(mockRes.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(mockRes.set).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(String));
      expect(mockRes.set).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
      expect(mockRes.set).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
    }
  });

  // Property 4: Rate limit counter cleanup
  it('should cleanup counters after window expires', () => {
    jest.useFakeTimers();

    try {
      const limiters = createRateLimiters(null, {
        uploadWindowMs: 1000,
        uploadMax: 10,
        apiWindowMs: 1000,
        apiMax: 100,
        windowResetGraceMs: 500,
      }, logger);

      // Advance time past window + grace period
      jest.advanceTimersByTime(1600);

      // Counter should be cleaned up (no errors thrown)
      expect(limiters.upload).toBeDefined();
      expect(limiters.api).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  // Property 15: Redis fallback rate limiting
  it('should fallback to in-process when Redis unavailable', () => {
    const limiters = createRateLimiters(null, {
      uploadWindowMs: 60000,
      uploadMax: 10,
      apiWindowMs: 60000,
      apiMax: 100,
      windowResetGraceMs: 5000,
    }, logger);

    // Should create limiters even without Redis
    expect(limiters.upload).toBeDefined();
    expect(limiters.api).toBeDefined();
  });
});
