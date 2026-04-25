import { IncomingMessage, ServerResponse } from 'http';
import { Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream, unlink, rename } from 'fs';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { Logger } from './types';

const unlinkAsync = promisify(unlink);
const renameAsync = promisify(rename);

export interface UploadPipelineConfig {
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  tempDir: string;
  finalDir: string;
}

export interface UploadResult {
  hash: string;
}

export interface UploadPipelineHandle {
  readonly pendingCount: number;
  handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    tempPath: string,
    finalPath: string
  ): Promise<UploadResult | null>;
}

/** Alias for backward compatibility with health-monitor.ts */
export type UploadPipeline = UploadPipelineHandle;

// Named error codes for pipeline errors
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly code: 'LIMIT_EXCEEDED' | 'MIME_INVALID' | 'STREAM_ERROR' | 'CLIENT_DISCONNECT'
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Detects MIME type from magic bytes for common image formats.
 * Falls back to null if unrecognized (caller decides whether to allow).
 */
async function detectMimeType(buf: Buffer): Promise<string | null> {
  // Try dynamic import of file-type (ESM-only package)
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const result = await fileTypeFromBuffer(buf);
    return result?.mime ?? null;
  } catch {
    // Fallback: manual magic bytes for common types
    if (buf.length >= 4) {
      // JPEG: FF D8 FF
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
      // PNG: 89 50 4E 47
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
      // GIF: 47 49 46 38
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
      // WebP: 52 49 46 46 ... 57 45 42 50
      if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    }
    return null;
  }
}

/**
 * Transform that validates MIME type from the first chunk using magic bytes.
 * Emits MIME_INVALID error if the detected type is not in allowedMimeTypes.
 * If allowedMimeTypes includes 'application/octet-stream', all files pass through.
 */
class MimeTypeValidator extends Transform {
  private firstChunkBuffer: Buffer[] = [];
  private firstChunkSize = 0;
  private mimeChecked = false;
  private readonly PEEK_BYTES = 256;

  constructor(
    private readonly allowedMimeTypes: string[],
    private readonly logger: Logger
  ) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    if (this.mimeChecked) {
      this.push(chunk);
      callback();
      return;
    }

    this.firstChunkBuffer.push(chunk);
    this.firstChunkSize += chunk.length;

    if (this.firstChunkSize >= this.PEEK_BYTES) {
      this._checkMime(callback);
    } else {
      // Need more data — buffer it
      callback();
    }
  }

  _flush(callback: TransformCallback): void {
    if (!this.mimeChecked) {
      this._checkMime(callback);
    } else {
      callback();
    }
  }

  private _checkMime(callback: TransformCallback): void {
    const buf = Buffer.concat(this.firstChunkBuffer);
    this.firstChunkBuffer = [];

    detectMimeType(buf).then((mime) => {
      this.mimeChecked = true;

      // If allowedMimeTypes includes 'application/octet-stream', allow everything
      if (this.allowedMimeTypes.includes('application/octet-stream')) {
        this.push(buf);
        callback();
        return;
      }

      const detectedMime = mime ?? 'application/octet-stream';
      if (!this.allowedMimeTypes.includes(detectedMime)) {
        this.logger.warn('MIME type not allowed', { detected: detectedMime, allowed: this.allowedMimeTypes });
        callback(new UploadError(`MIME type not allowed: ${detectedMime}`, 'MIME_INVALID'));
        return;
      }

      this.push(buf);
      callback();
    }).catch((err) => {
      callback(err);
    });
  }
}

/**
 * Transform that counts bytes and throws LIMIT_EXCEEDED if > maxFileSizeBytes.
 * Also computes a SHA-256 hash of the data passing through.
 */
class SizeLimitTransform extends Transform {
  private totalBytes = 0;
  private readonly hasher = createHash('sha256');

  constructor(
    private readonly maxFileSizeBytes: number,
    private readonly logger: Logger
  ) {
    super();
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.totalBytes += chunk.length;

    if (this.totalBytes > this.maxFileSizeBytes) {
      this.logger.warn('Upload size limit exceeded', {
        received: this.totalBytes,
        limit: this.maxFileSizeBytes,
      });
      callback(new UploadError(
        `File size ${this.totalBytes} exceeds limit ${this.maxFileSizeBytes}`,
        'LIMIT_EXCEEDED'
      ));
      return;
    }

    this.hasher.update(chunk);
    this.push(chunk);
    callback();
  }

  getHash(): string {
    return this.hasher.digest('hex');
  }
}

/**
 * Deletes a file, ignoring ENOENT errors.
 */
async function safeUnlink(filePath: string, logger: Logger): Promise<void> {
  try {
    await unlinkAsync(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error('Failed to delete temp file', { path: filePath, error: String(err) });
    }
  }
}

/**
 * Creates an upload pipeline handler.
 *
 * @returns `{ handleUpload, pendingCount }`
 */
export function createUploadPipeline(
  config: UploadPipelineConfig,
  logger: Logger
): UploadPipelineHandle {
  let _pendingCount = 0;

  async function handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    tempPath: string,
    finalPath: string
  ): Promise<UploadResult | null> {
    _pendingCount++;

    const mimeValidator = new MimeTypeValidator(config.allowedMimeTypes, logger);
    const sizeLimit = new SizeLimitTransform(config.maxFileSizeBytes, logger);
    const writeStream = createWriteStream(tempPath);

    let pipelineCompleted = false;

    // Detect client disconnect mid-upload.
    // When the underlying socket closes before the pipeline finishes,
    // the req stream will error/end prematurely, causing pipeline() to reject.
    // We track the close event only to label the error correctly.
    let clientDisconnected = false;
    const onClose = (): void => {
      if (!pipelineCompleted) {
        clientDisconnected = true;
      }
    };
    req.on('close', onClose);

    try {
      await pipeline(req as NodeJS.ReadableStream, mimeValidator, sizeLimit, writeStream);
      pipelineCompleted = true;

      // Success: atomic rename
      await renameAsync(tempPath, finalPath);
      const hash = sizeLimit.getHash();
      logger.info('Upload completed', { tempPath, finalPath, hash });

      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, hash }));
      }

      return { hash };
    } catch (err: unknown) {
      const uploadErr = err instanceof UploadError ? err : null;
      // A real client disconnect is a network-level error (ECONNRESET, EPIPE),
      // not just any stream destruction. Check the error code to distinguish.
      const errCode = (err as NodeJS.ErrnoException)?.code;
      const isNetworkDisconnect = errCode === 'ECONNRESET' || errCode === 'EPIPE';
      const isClientDisconnect = (clientDisconnected && isNetworkDisconnect) || uploadErr?.code === 'CLIENT_DISCONNECT';

      // Clean up temp file
      await safeUnlink(tempPath, logger);

      if (res.headersSent) {
        logger.warn('Upload failed after headers sent', { error: String(err) });
        return null;
      }

      if (uploadErr?.code === 'LIMIT_EXCEEDED') {
        logger.warn('Upload rejected: size limit exceeded', { error: uploadErr.message });
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large' }));
      } else if (uploadErr?.code === 'MIME_INVALID') {
        logger.warn('Upload rejected: invalid MIME type', { error: uploadErr.message });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid file type' }));
      } else if (isClientDisconnect) {
        logger.info('Upload aborted: client disconnected');
        // No response needed — client is gone
      } else {
        logger.error('Upload failed: stream error', { error: String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload failed' }));
      }

      return null;
    } finally {
      req.removeListener('close', onClose);
      _pendingCount--;
    }
  }

  return {
    get pendingCount(): number {
      return _pendingCount;
    },
    handleUpload,
  };
}
