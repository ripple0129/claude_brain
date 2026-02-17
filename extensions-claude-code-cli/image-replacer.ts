import { access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { uploadToCatbox } from "./image-uploader.js";

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * Match image file paths in text.
 * Handles:
 *   - Absolute paths: /Users/ripple/.../foo.png
 *   - Relative paths: imagen/foo.png
 *   - Paths after "saved to: " or similar context
 */
const PATH_RE = /(?:(?:\/[\w.@~ -]+)+|(?:[\w.-]+\/)+[\w.-]+)\.(?:png|jpe?g|gif|webp)\b/gi;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan text for local image file paths, upload each to catbox.moe,
 * and replace the path with the public URL.
 */
export async function replaceImagePaths(
  text: string,
  workDir: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string> {
  const matches = text.match(PATH_RE);
  if (!matches) return text;

  const uniquePaths = [...new Set(matches)];

  const replacements = await Promise.all(
    uniquePaths.map(async (rawPath) => {
      const absPath = isAbsolute(rawPath) ? rawPath : resolve(workDir, rawPath);

      if (!(await fileExists(absPath))) return null;
      if (!IMAGE_EXTENSIONS.test(absPath)) return null;

      logger?.info(`image-replacer: uploading ${absPath}`);
      const url = await uploadToCatbox(absPath);

      if (url) {
        logger?.info(`image-replacer: uploaded → ${url}`);
        return { rawPath, url };
      } else {
        logger?.warn(`image-replacer: upload failed for ${absPath}`);
        return null;
      }
    }),
  );

  let result = text;
  for (const r of replacements) {
    if (!r) continue;
    result = result.split(r.rawPath).join(r.url);
  }

  return result;
}

/**
 * Scan text for local image file paths, upload each to catbox.moe,
 * and return the list of uploaded URLs.
 * Used by bridge-server to append image URLs at the end of an SSE stream.
 */
export async function findAndUploadImages(
  text: string,
  workDir: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string[]> {
  const matches = text.match(PATH_RE);
  if (!matches) return [];

  const uniquePaths = [...new Set(matches)];

  const results = await Promise.all(
    uniquePaths.map(async (rawPath) => {
      const absPath = isAbsolute(rawPath) ? rawPath : resolve(workDir, rawPath);

      if (!(await fileExists(absPath))) return null;
      if (!IMAGE_EXTENSIONS.test(absPath)) return null;

      logger?.info(`image-replacer: uploading ${absPath}`);
      const url = await uploadToCatbox(absPath);

      if (url) {
        logger?.info(`image-replacer: uploaded → ${url}`);
        return url;
      }
      logger?.warn(`image-replacer: upload failed for ${absPath}`);
      return null;
    }),
  );

  return results.filter((u): u is string => u !== null);
}
