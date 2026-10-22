import { describe, expect, it } from 'vitest';
import {
  decodeDiagnosticBytes,
  diagnosticBudgetErrors,
  readDiagnosticFile,
  reviewedDiagnosticFile,
  suggestDiagnosticRedactions,
  utf8Size,
} from '../services/diagnosticFiles';
import type { DiagnosticAttachmentCapability } from '../services/diagnosticFiles';

const capability: DiagnosticAttachmentCapability = {
  enabled: true,
  maxAttachments: 4,
  maxImageBytes: 8 * 1024 * 1024,
  maxTextFileBytes: 1024 * 1024,
  maxTotalTextBytes: 128 * 1024,
  maxTotalImageBytes: 16 * 1024 * 1024,
};

const utf16 = (source: string, littleEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(2 + source.length * 2);
  bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < source.length; i += 1) view.setUint16(2 + i * 2, source.charCodeAt(i), littleEndian);
  return bytes;
};

describe('reviewed Windows diagnostic files', () => {
  it.each([true, false])('decodes BOM UTF-16 (little endian: %s) without losing Unicode or lines', littleEndian => {
    expect(decodeDiagnosticBytes(utf16('Windows\r\nTempérature: 42°C 😀\rNext', littleEndian)))
      .toBe('Windows\nTempérature: 42°C 😀\nNext');
  });

  it('keeps XML inert, including external entities and markup', () => {
    const xml = '<!DOCTYPE report [<!ENTITY source SYSTEM "file:///etc/passwd">]>\n<report>&source;</report>';
    expect(decodeDiagnosticBytes(new TextEncoder().encode(xml))).toBe(xml);
  });

  it.each([
    new Uint8Array([0x4d, 0x5a, 0, 0, 0]),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0]),
    new Uint8Array([0x41, 0, 0x42, 0]),
    new Uint8Array([0xff, 0xfe, 0x00, 0xd8]),
  ])('rejects binary, malformed UTF-8/UTF-16 and UTF-32', bytes => {
    expect(() => decodeDiagnosticBytes(bytes)).toThrow(/binary|valid UTF|UTF-32/i);
  });

  it('suggests explicit, idempotent redactions while preserving diagnostic lines', () => {
    const source = 'password="private value"\nauthorization: Bearer private-token\nEmail: person@example.com\nC:\\Users\\Alice\\Desktop\\dxdiag.log\nBuild=26100';
    const suggestion = suggestDiagnosticRedactions(source);
    expect(suggestion.count).toBe(4);
    expect(suggestion.text).not.toContain('private');
    expect(suggestion.text).not.toContain('person@example.com');
    expect(suggestion.text).not.toContain('Alice');
    expect(suggestion.text.split('\n')).toHaveLength(source.split('\n').length);
    expect(suggestion.text).toContain('Build=26100');
    expect(suggestDiagnosticRedactions(suggestion.text)).toEqual({ text: suggestion.text, count: 0 });
    expect(source).toContain('person@example.com');
  });

  it('builds a UTF-8 derivative and leaves original diagnostic bytes untouched', async () => {
    const bytes = utf16('First\r\nSecond', true);
    const original = new File([new Uint8Array(bytes)], 'DxDiag.log', { type: 'application/octet-stream' });
    const text = await readDiagnosticFile(original, capability.maxTextFileBytes);
    const derivative = reviewedDiagnosticFile(original.name, `${text}\nReviewed`);
    expect(derivative.name).toBe('DxDiag.log.reviewed.txt');
    expect(derivative.type).toBe('text/plain');
    expect(await readDiagnosticFile(derivative, capability.maxTextFileBytes)).toBe('First\nSecond\nReviewed');
    expect(original.size).toBe(bytes.byteLength);
    expect(utf8Size('é😀')).toBe(6);
  });

  it('redacts user directory names containing spaces and labeled tokens', () => {
    const suggestion = suggestDiagnosticRedactions('C:\\Users\\A Synthetic Person\\Desktop\\report.log\ntoken=synthetic-secret');
    expect(suggestion.count).toBe(2);
    expect(suggestion.text).toBe('C:\\Users\\[REDACTED]\\Desktop\\report.log\ntoken=[REDACTED]');
  });

  it('rejects an oversized original before reading it', async () => {
    await expect(readDiagnosticFile(new File(['12345'], 'large.log'), 4)).rejects.toThrow(/original file exceeds/);
  });

  it('checks combined text and image budgets against existing and new files', () => {
    const text = (name: string, size: number) => ({ name, mime: 'text/plain', size });
    expect(diagnosticBudgetErrors([text('existing.txt', 65536), text('reviewed.txt', 65536)], capability)).toEqual([]);
    expect(diagnosticBudgetErrors([text('existing.txt', 65536), text('reviewed.txt', 65537)], capability))
      .toEqual([expect.stringMatching(/131,073 bytes.*131,072.*no text will be truncated/)]);
    expect(diagnosticBudgetErrors(Array.from({ length: 5 }, (_, i) => text(`${i}.txt`, 1)), capability))
      .toContain('Choose no more than 4 files for this message.');
    expect(diagnosticBudgetErrors([
      { name: 'one.png', mime: 'image/png', size: 8 * 1024 * 1024 },
      { name: 'two.png', mime: 'image/png', size: 8 * 1024 * 1024 },
      { name: 'three.png', mime: 'image/png', size: 1 },
    ], capability)).toEqual([expect.stringMatching(/Selected images total/)]);
  });
});
