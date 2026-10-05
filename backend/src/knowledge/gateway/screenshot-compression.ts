import sharp from "sharp";

export const MODEL_SCREENSHOT_MAX_BYTES = 512 * 1024;

const PROFILES = [
  { width: 1280, quality: 68 },
  { width: 960, quality: 56 },
  { width: 720, quality: 44 },
  { width: 512, quality: 35 },
] as const;

export interface ModelScreenshot {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Keep the full PNG in the sandbox, but bound the copy carried in model history. The size the
 *  model sees is returned with it: the model's coordinates are in that space. */
export async function compressScreenshotForModelSized(
  source: Buffer,
  options: { readonly crop?: { left: number; top: number; width: number; height: number }; readonly allowEnlargement?: boolean } = {},
): Promise<ModelScreenshot> {
  if (source.byteLength === 0) throw new Error("desktop screenshot was empty");
  for (const profile of PROFILES) {
    let image = sharp(source, { limitInputPixels: 50_000_000 });
    if (options.crop) {
      const meta = await image.metadata();
      const left = Math.min(options.crop.left, Math.max(0, (meta.width ?? 1) - 1));
      const top = Math.min(options.crop.top, Math.max(0, (meta.height ?? 1) - 1));
      image = image.extract({
        left,
        top,
        width: Math.max(1, Math.min(options.crop.width, (meta.width ?? 1) - left)),
        height: Math.max(1, Math.min(options.crop.height, (meta.height ?? 1) - top)),
      });
    }
    const { data, info } = await image
      .resize({
        width: profile.width,
        height: profile.width,
        fit: "inside",
        withoutEnlargement: !options.allowEnlargement,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: profile.quality, progressive: true, chromaSubsampling: "4:2:0" })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= MODEL_SCREENSHOT_MAX_BYTES) return { buffer: data, width: info.width, height: info.height };
  }
  throw new Error("desktop screenshot could not be compressed below the model payload limit");
}

export async function compressScreenshotForModel(source: Buffer): Promise<Buffer> {
  return (await compressScreenshotForModelSized(source)).buffer;
}
