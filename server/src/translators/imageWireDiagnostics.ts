import { createHash } from 'node:crypto';

type ImageWirePart = {
  contentIndex: number;
  partIndex: number;
  field: string;
  mimeType?: string;
} & ({
  transport: 'base64';
  base64Chars: number;
  decodedBytes: number;
  sha256: string;
} | {
  transport: 'url';
  urlChars: number;
});

export interface ImageWireDiagnostics {
  jsonBytes: number;
  jsonSha256: string;
  images: ImageWirePart[];
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Summarize the exact serialized request without retaining image data or reference URLs in logs. */
export function serializeGeminiImageRequest(body: Record<string, unknown>): { bodyText: string; diagnostics: ImageWireDiagnostics } {
  const bodyText = JSON.stringify(body);
  // Read the serialized snapshot so diagnostics also match objects with toJSON/omitted properties.
  const snapshot = JSON.parse(bodyText);
  const images: ImageWirePart[] = [];
  for (const [contentIndex, content] of (snapshot.contents ?? []).entries()) {
    for (const [partIndex, part] of (content.parts ?? []).entries()) {
      for (const field of ['inlineData', 'inline_data']) {
        const value = part[field];
        if (typeof value?.data !== 'string') continue;
        const bytes = Buffer.from(value.data, 'base64');
        images.push({ contentIndex, partIndex, field: `${field}.data`, mimeType: value.mimeType ?? value.mime_type,
          transport: 'base64', base64Chars: value.data.length, decodedBytes: bytes.length, sha256: sha256(bytes) });
      }
      for (const field of ['fileData', 'file_data']) {
        const value = part[field];
        const uriField = typeof value?.fileUri === 'string' ? 'fileUri' : 'file_uri';
        if (typeof value?.[uriField] !== 'string') continue;
        images.push({ contentIndex, partIndex, field: `${field}.${uriField}`, mimeType: value.mimeType ?? value.mime_type,
          transport: 'url', urlChars: value[uriField].length });
      }
    }
  }
  return { bodyText, diagnostics: { jsonBytes: Buffer.byteLength(bodyText), jsonSha256: sha256(bodyText), images } };
}
