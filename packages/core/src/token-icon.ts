/** Token logos are rendered only as `<img src>`, where even an SVG cannot run scripts. Real icons are 0.5–11 KB. */
export const MAX_TOKEN_ICON_LENGTH = 32_768;

const BASE64 = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const PLAIN = /^data:image\/(png|jpeg|webp|gif|svg\+xml)(;charset=[\w-]+)?,[\x20-\x21\x23-\x7e]+$/;

/** A token logo from untrusted data (`ft_metadata.icon`), or null unless an image data URI within the size cap. */
export function safeTokenIcon(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_TOKEN_ICON_LENGTH) return null;
  return BASE64.test(raw) || PLAIN.test(raw) ? raw : null;
}
