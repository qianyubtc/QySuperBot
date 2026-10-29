import { z } from 'zod';
import { sha } from './security.ts';

const imageReference = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('upload'), asset_id: z.string().regex(/^upload-image-[a-f0-9]{64}$/) }),
  z.object({
    provider: z.literal('telegram'),
    asset_id: z.string().max(256),
    file_id: z.string().min(1).max(2048),
  }),
  z.object({
    provider: z.literal('qq'),
    asset_id: z.string().max(256),
    file: z.string().max(2048).optional(),
    url: z.string().max(8192).optional(),
  }),
]);
export type ImageReference = z.infer<typeof imageReference>;
export type Presentation = { avatar_url?: string; images?: ImageReference[] };

export function publicImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && /(^|\.)(qq\.com|qpic\.cn)$/.test(url.hostname)) url.protocol = 'https:';
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url.toString();
  } catch {
    /* keep a default avatar or an unavailable image */
  }
}
export function normalizePresentation(input?: Presentation): Presentation {
  const images = (input?.images ?? []).slice(0, 100).flatMap((image) => {
    const parsed = imageReference.safeParse(image);
    return parsed.success ? [parsed.data] : [];
  });
  return { avatar_url: publicImageUrl(input?.avatar_url), images };
}
export function qqImages(payload: any): ImageReference[] {
  return (Array.isArray(payload.message) ? payload.message : [])
    .flatMap((part: any, index: number) =>
      part.type === 'image'
        ? [
            {
              provider: 'qq' as const,
              asset_id: `qq-image-${sha(String(payload.message_id)).slice(0, 24)}-${index}`,
              ...(typeof part.data?.file === 'string' ? { file: part.data.file } : {}),
              ...(publicImageUrl(part.data?.url) ? { url: publicImageUrl(part.data.url) } : {}),
            },
          ]
        : [],
    )
    .slice(0, 100);
}
