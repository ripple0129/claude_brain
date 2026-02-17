import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const CATBOX_UPLOAD_URL = "https://catbox.moe/user/api.php";

/**
 * Upload a local image file to catbox.moe (free, anonymous, no API key).
 * Returns the public URL on success, or null on failure.
 */
export async function uploadToCatbox(filePath: string): Promise<string | null> {
  try {
    const data = await readFile(filePath);
    const fileName = basename(filePath);

    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", new Blob([data]), fileName);

    const res = await fetch(CATBOX_UPLOAD_URL, {
      method: "POST",
      body: form,
    });

    if (!res.ok) return null;

    const url = (await res.text()).trim();
    // catbox returns the raw URL string, e.g. "https://files.catbox.moe/abc123.png"
    if (url.startsWith("https://")) return url;
    return null;
  } catch {
    return null;
  }
}
