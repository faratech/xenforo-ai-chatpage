/** Local-only preparation of diagnostic text. Nothing here uploads a file. */
export interface DiagnosticAttachmentCapability {
  enabled: boolean;
  maxAttachments: number;
  maxImageBytes: number;
  maxTextFileBytes: number;
  maxTotalTextBytes: number;
  maxTotalImageBytes: number;
}

export const DIAGNOSTIC_EXTENSIONS = new Set(['log', 'xml', 'nfo']);

export const utf8Size = (text: string): number => new TextEncoder().encode(text).byteLength;

/** BOM-marked Windows UTF-16 exports are converted to a reviewed UTF-8 derivative. */
export const decodeDiagnosticBytes = (bytes: Uint8Array): string => {
  if (bytes.length === 0) throw new Error('Empty files cannot be reviewed.');
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) {
    throw new Error('Use UTF-8 or BOM-marked UTF-16 text; UTF-32 and binary files are unsupported.');
  }
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Use valid UTF-8 or BOM-marked UTF-16 text. Binary NFO exports cannot be read.');
  }
  // NULs and binary control characters are never useful diagnostic text. XML
  // remains inert text: do not parse entities, stylesheets, or external URLs.
  if (Array.from(text).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  }) || text.includes('\u007f')) {
    throw new Error('This appears to be a binary file. Export a plain-text report instead.');
  }
  return text.replace(/\r\n?/g, '\n');
};

export const readDiagnosticFile = async (file: File, maxBytes: number): Promise<string> => {
  if (file.size > maxBytes) throw new Error(`The original file exceeds the ${maxBytes.toLocaleString()} byte file limit. Export a smaller report.`);
  const buffer = typeof file.arrayBuffer === 'function'
    ? await file.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer
        ? resolve(reader.result) : reject(new Error('The file could not be read.'));
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.readAsArrayBuffer(file);
    });
  return decodeDiagnosticBytes(new Uint8Array(buffer));
};

export interface RedactionSuggestion {
  text: string;
  count: number;
}

/** Conservative suggestions, explicitly applied by the user; never a privacy guarantee. */
export const suggestDiagnosticRedactions = (source: string): RedactionSuggestion => {
  let count = 0;
  const replaceValue = (match: string, prefix: string, value: string) => {
    if (value.startsWith('[REDACTED')) return match;
    count += 1;
    return `${prefix}[REDACTED]`;
  };
  let text = source.replace(
    /(\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|token|authorization|secret)\s*[:=]\s*)((?:Bearer\s+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,;<>]+))/gi,
    replaceValue,
  );
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
    count += 1;
    return '[REDACTED EMAIL]';
  });
  text = text.replace(/(\b[A-Z]:\\Users\\|\/Users\/|\/home\/)([^\\/\r\n<>]+)/gi, replaceValue);
  return { text, count };
};

export const reviewedDiagnosticFile = (originalName: string, text: string): File =>
  new File([text], `${originalName}.reviewed.txt`, { type: 'text/plain' });

export interface AttachmentBudgetItem {
  name: string;
  mime: string;
  size: number;
}

/** Returns actionable errors and never silently truncates or drops content. */
export const diagnosticBudgetErrors = (
  items: readonly AttachmentBudgetItem[],
  capability: DiagnosticAttachmentCapability,
): string[] => {
  const errors: string[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  if (items.length > capability.maxAttachments) errors.push(`Choose no more than ${capability.maxAttachments} files for this message.`);
  for (const item of items) {
    const image = item.mime.startsWith('image/');
    if (item.size < 1) errors.push(`${item.name}: remove this empty file or add text.`);
    const limit = image ? capability.maxImageBytes : capability.maxTextFileBytes;
    if (item.size > limit) errors.push(`${item.name}: exceeds the ${limit.toLocaleString()} byte ${image ? 'image' : 'text file'} limit.`);
    if (image) imageBytes += item.size;
    else textBytes += item.size;
  }
  if (textBytes > capability.maxTotalTextBytes) {
    errors.push(`Selected text totals ${textBytes.toLocaleString()} bytes; this message allows ${capability.maxTotalTextBytes.toLocaleString()}. Edit or exclude files; no text will be truncated.`);
  }
  if (imageBytes > capability.maxTotalImageBytes) {
    errors.push(`Selected images total ${imageBytes.toLocaleString()} bytes; this message allows ${capability.maxTotalImageBytes.toLocaleString()}. Remove or exclude an image.`);
  }
  return errors;
};
