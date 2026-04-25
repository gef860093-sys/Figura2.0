import { createUploadPipeline, UploadError } from '../../upload-pipeline';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { IncomingMessage, ServerResponse } from 'http';
import * as fc from 'fast-check';

// Minimal mock logger
function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
    flush: jest.fn(),
  };
}

// Build a minimal mock ServerResponse
function makeRes(): ServerResponse {
  const res: any = {
    headersSent: false,
    _statusCode: 0,
    _body: '',
    writeHead(code: number) {
      this._statusCode = code;
      this.headersSent = true;
    },
    end(body: string) {
      this._body = body;
    },
  };
  return res as ServerResponse;
}

// Build a Readable that emits the given buffer then ends
function makeReq(data: Buffer): IncomingMessage {
  const r = new Readable({ read() {} }) as any;
  r.push(data);
  r.push(null);
  return r as IncomingMessage;
}

// Build a Readable that emits data then destroys with an error
function makeErrorReq(data: Buffer, delayMs = 10): IncomingMessage {
  const r = new Readable({ read() {} }) as any;
  r.push(data);
  setTimeout(() => r.destroy(new Error('Simulated stream error')), delayMs);
  return r as IncomingMessage;
}

describe('Upload Pipeline', () => {
  let tempDir: string;
  let finalDir: string;

  beforeEach(() => {
    tempDir = path.join(tmpdir(), `up-test-temp-${Date.now()}`);
    finalDir = path.join(tmpdir(), `up-test-final-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(finalDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(finalDir, { recursive: true, force: true });
  });

  // ─── Basic success ────────────────────────────────────────────────────────

  it('returns a hash and moves file to finalPath on success', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 1024, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
      logger
    );

    const data = Buffer.from('hello world');
    const tempPath = path.join(tempDir, 'file.tmp');
    const finalPath = path.join(finalDir, 'file.bin');
    const res = makeRes();

    const result = await up.handleUpload(makeReq(data), res, tempPath, finalPath);

    // Debug: log what the logger captured
    if (result === null) {
      console.log('DEBUG logger.error calls:', logger.error.mock.calls);
      console.log('DEBUG logger.warn calls:', logger.warn.mock.calls);
      console.log('DEBUG logger.info calls:', logger.info.mock.calls);
      console.log('DEBUG res._statusCode:', (res as any)._statusCode);
      console.log('DEBUG res.headersSent:', (res as any).headersSent);
    }

    expect(result).not.toBeNull();
    expect(result!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(tempPath)).toBe(false);
    expect((res as any)._statusCode).toBe(200);
  });

  // ─── pendingCount tracking ────────────────────────────────────────────────

  it('increments pendingCount during upload and decrements after', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 1024, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
      logger
    );

    expect(up.pendingCount).toBe(0);

    const data = Buffer.from('data');
    const tempPath = path.join(tempDir, 'cnt.tmp');
    const finalPath = path.join(finalDir, 'cnt.bin');

    const promise = up.handleUpload(makeReq(data), makeRes(), tempPath, finalPath);
    // pendingCount should be 1 while in flight
    expect(up.pendingCount).toBe(1);

    await promise;
    expect(up.pendingCount).toBe(0);
  });

  // ─── Property 11: Invalid uploads produce no disk writes ─────────────────
  // Feature: bigavatar-server-stability, Property 11: Invalid uploads produce no disk writes
  // Validates: Requirements 3.3

  it('rejects oversized files with HTTP 413 and no temp file on disk', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 10, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
      logger
    );

    const data = Buffer.alloc(100, 0xab);
    const tempPath = path.join(tempDir, 'big.tmp');
    const finalPath = path.join(finalDir, 'big.bin');
    const res = makeRes();

    const result = await up.handleUpload(makeReq(data), res, tempPath, finalPath);

    expect(result).toBeNull();
    expect((res as any)._statusCode).toBe(413);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
  });

  it('rejects disallowed MIME types with HTTP 400 and no temp file on disk', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 1024 * 1024, allowedMimeTypes: ['image/png'], tempDir, finalDir },
      logger
    );

    // JPEG magic bytes — not in allowedMimeTypes
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(252)]);
    const tempPath = path.join(tempDir, 'mime.tmp');
    const finalPath = path.join(finalDir, 'mime.bin');
    const res = makeRes();

    const result = await up.handleUpload(makeReq(jpegHeader), res, tempPath, finalPath);

    expect(result).toBeNull();
    expect((res as any)._statusCode).toBe(400);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
  });

  // ─── Property 10: Upload interruption cleanup ─────────────────────────────
  // Feature: bigavatar-server-stability, Property 10: Upload interruption cleanup
  // Validates: Requirements 3.1, 3.2

  it('deletes temp file on stream error and returns HTTP 500', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 1024 * 1024, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
      logger
    );

    const tempPath = path.join(tempDir, 'err.tmp');
    const finalPath = path.join(finalDir, 'err.bin');
    const res = makeRes();

    const result = await up.handleUpload(
      makeErrorReq(Buffer.from('partial'), 5),
      res,
      tempPath,
      finalPath
    );

    expect(result).toBeNull();
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(false);
    expect((res as any)._statusCode).toBe(500);
  });

  // ─── Property 14: Successful upload atomic move ───────────────────────────
  // Feature: bigavatar-server-stability, Property 14: Successful upload atomic move
  // Validates: Requirements 3.7

  it('final file exists and temp file does not exist after successful upload', async () => {
    const logger = makeLogger();
    const up = createUploadPipeline(
      { maxFileSizeBytes: 1024 * 1024, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
      logger
    );

    const data = Buffer.from('avatar content');
    const tempPath = path.join(tempDir, 'avatar.tmp');
    const finalPath = path.join(finalDir, 'avatar.bin');

    await up.handleUpload(makeReq(data), makeRes(), tempPath, finalPath);

    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(tempPath)).toBe(false);
  });

  // ─── Property-based: size limit invariant ────────────────────────────────
  // Feature: bigavatar-server-stability, Property 11: Invalid uploads produce no disk writes
  // Validates: Requirements 3.3

  it('property: files exceeding size limit never reach disk', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),   // maxFileSizeBytes
        fc.integer({ min: 1, max: 10 }),   // extra bytes over limit
        async (limit, extra) => {
          const logger = makeLogger();
          const up = createUploadPipeline(
            { maxFileSizeBytes: limit, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
            logger
          );

          const data = Buffer.alloc(limit + extra, 0x42);
          const tempPath = path.join(tempDir, `prop-${limit}-${extra}.tmp`);
          const finalPath = path.join(finalDir, `prop-${limit}-${extra}.bin`);
          const res = makeRes();

          const result = await up.handleUpload(makeReq(data), res, tempPath, finalPath);

          return (
            result === null &&
            !existsSync(tempPath) &&
            !existsSync(finalPath) &&
            (res as any)._statusCode === 413
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─── Property-based: successful upload always produces hash + final file ──
  // Feature: bigavatar-server-stability, Property 14: Successful upload atomic move
  // Validates: Requirements 3.7

  it('property: valid uploads always produce a hash and final file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 100 }),
        async (bytes) => {
          const logger = makeLogger();
          const data = Buffer.from(bytes);
          const up = createUploadPipeline(
            { maxFileSizeBytes: 1024, allowedMimeTypes: ['application/octet-stream'], tempDir, finalDir },
            logger
          );

          const id = `${Date.now()}-${Math.random()}`;
          const tempPath = path.join(tempDir, `${id}.tmp`);
          const finalPath = path.join(finalDir, `${id}.bin`);

          const result = await up.handleUpload(makeReq(data), makeRes(), tempPath, finalPath);

          const ok =
            result !== null &&
            typeof result.hash === 'string' &&
            result.hash.length === 64 &&
            existsSync(finalPath) &&
            !existsSync(tempPath);

          // Cleanup for next iteration
          try { rmSync(finalPath); } catch {}

          return ok;
        }
      ),
      { numRuns: 50 }
    );
  });
});
