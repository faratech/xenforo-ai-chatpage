export interface JSONDownloadArtifact {
  filename: string;
  content: string;
  blob: Blob;
}

const datePart = (timestamp: number): string => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'export';
};
/** Build a portable JSON artifact without retaining the server response. */
export const createAccountDataArtifact = (
  data: unknown,
  generatedAt: number,
): JSONDownloadArtifact => {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  return {
    filename: `windowsforum-ai-data-${datePart(generatedAt)}.json`,
    content,
    blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
  };
};

export const downloadJSONArtifact = (
  artifact: JSONDownloadArtifact,
  targetDocument: Document = document,
): void => {
  const objectUrl = URL.createObjectURL(artifact.blob);
  const link = targetDocument.createElement('a');
  link.href = objectUrl;
  link.download = artifact.filename;
  link.hidden = true;
  targetDocument.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
};

export const canonicalConversationShareUrl = (
  token: string,
  origin: string = window.location.origin,
): string => {
  const url = new URL('/pages/ai/', origin);
  url.searchParams.set('share', token);
  return url.href;
};

export const writeClipboardText = async (
  value: string,
  targetNavigator: Navigator = navigator,
  targetDocument: Document = document,
): Promise<void> => {
  if (targetNavigator.clipboard?.writeText) {
    await targetNavigator.clipboard.writeText(value);
    return;
  }

  const input = targetDocument.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  targetDocument.body.append(input);
  input.select();
  const copied = targetDocument.execCommand?.('copy') ?? false;
  input.remove();
  if (!copied) throw new Error('Clipboard access is unavailable. Copy the new URL manually.');
};
