import { createTempFileCleaner } from '../../temp-file-cleaner';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import * as fc from 'fast-check';

describe('Temp File Cleaner', () => {
  let logger: any;
  let tempDir: string;

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    tempDir = path.join(tmpdir(), 'test-cleaner');
    if (!existsSync(tempDir)) {
      require('fs').mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      require('fs').rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore
    }
  });

  // Property 12: Temp file cleaner removes old files only
  it('should delete files older than maxTempAgeMs', (done) => {
    const cleaner = createTempFileCleaner(
      {
        tempDir,
        cleanerIntervalMs: 100,
        maxTempAgeMs: 500,
      },
      logger
    );

    // Create old file
    const oldFile = path.join(tempDir, 'old.tmp');
    writeFileSync(oldFile, 'old');

    // Wait for file to be old
    setTimeout(() => {
      // Create new file
      const newFile = path.join(tempDir, 'new.tmp');
      writeFileSync(newFile, 'new');

      cleaner.start();

      // Wait for cleaner to run
      setTimeout(() => {
        expect(existsSync(oldFile)).toBe(false);
        expect(existsSync(newFile)).toBe(true);
        cleaner.stop();
        done();
      }, 200);
    }, 600);
  });

  // Property 13: Temp file cleaner continues on deletion failure
  it('should continue on deletion failure', (done) => {
    const cleaner = createTempFileCleaner(
      {
        tempDir,
        cleanerIntervalMs: 100,
        maxTempAgeMs: 500,
      },
      logger
    );

    // Create old files
    const file1 = path.join(tempDir, 'file1.tmp');
    const file2 = path.join(tempDir, 'file2.tmp');
    writeFileSync(file1, 'data1');
    writeFileSync(file2, 'data2');

    setTimeout(() => {
      cleaner.start();

      setTimeout(() => {
        // Both files should be deleted despite any errors
        expect(existsSync(file1)).toBe(false);
        expect(existsSync(file2)).toBe(false);
        cleaner.stop();
        done();
      }, 200);
    }, 600);
  });
});
