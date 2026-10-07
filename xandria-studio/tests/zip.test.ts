/**
 * QA X2 — ZipBuilder must stamp a fixed timestamp so repeated builds are
 * byte-identical (and honor SOURCE_DATE_EPOCH when set).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { ZipBuilder } from '../scripts/zip';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const savedSDE = process.env.SOURCE_DATE_EPOCH;
afterEach(() => {
  if (savedSDE === undefined) delete process.env.SOURCE_DATE_EPOCH;
  else process.env.SOURCE_DATE_EPOCH = savedSDE;
});

const buildSample = (): Uint8Array => {
  const z = new ZipBuilder();
  z.add('index.html', '<html><head></head><body>hi</body></html>');
  z.add('README.txt', 'hello world');
  z.add('cover.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return z.build();
};

/** DOS time/date of the first entry's local header (offsets 10/12). */
const firstEntryStamp = (zip: Uint8Array): { time: number; date: number } => {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  return { time: dv.getUint16(10, true), date: dv.getUint16(12, true) };
};

describe('ZipBuilder determinism', () => {
  it('builds byte-identical zips across runs', () => {
    expect(sha256(buildSample())).toBe(sha256(buildSample()));
  });

  it('stamps the fixed constant (2020-01-01 00:00 UTC) by default', () => {
    delete process.env.SOURCE_DATE_EPOCH;
    const { time, date } = firstEntryStamp(buildSample());
    expect(time).toBe(0);
    // ((2020-1980) << 9) | (1 << 5) | 1
    expect(date).toBe(20513);
  });

  it('honors SOURCE_DATE_EPOCH when set', () => {
    // 1234567890 = 2009-02-13 23:31:30 UTC
    process.env.SOURCE_DATE_EPOCH = '1234567890';
    const { time, date } = firstEntryStamp(buildSample());
    expect(time).toBe((23 << 11) | (31 << 5) | (30 >> 1));
    expect(date).toBe(((2009 - 1980) << 9) | (2 << 5) | 13);
    expect(sha256(buildSample())).toBe(sha256(buildSample()));
  });

  it('ignores a malformed SOURCE_DATE_EPOCH', () => {
    process.env.SOURCE_DATE_EPOCH = 'not-a-number';
    const { time, date } = firstEntryStamp(buildSample());
    expect(time).toBe(0);
    expect(date).toBe(20513);
  });
});
