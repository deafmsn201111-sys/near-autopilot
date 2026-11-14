/** Token logos are rendered only as `<img src>`, where even an SVG cannot run scripts. Real icons are 0.5–11 KB. */
export const MAX_TOKEN_ICON_LENGTH = 32_768;

const TYPE = 'data:image\\/(png|jpe?g|webp|gif|svg\\+xml)';
const BASE64 = new RegExp(`^${TYPE};base64,[A-Za-z0-9+/]+={0,2}$`);
const PLAIN = new RegExp(`^${TYPE}(;(?!base64,)[\\w=-]+)?,[\\x20-\\x7e]+$`);

export function safeTokenIcon(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_TOKEN_ICON_LENGTH) return null;
  return BASE64.test(raw) || PLAIN.test(raw) ? raw : null;
}
