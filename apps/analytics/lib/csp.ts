/**
 * Only scripts carrying this response's nonce run, plus what they load ('strict-dynamic'). HOT Connector runs each
 * wallet in a sandboxed srcdoc iframe that inherits this policy: it gets the nonce (lib/wallet.ts) and talks to its
 * own backends, hence the broad connect/frame/img sources. Styles stay inline-friendly (React style props).
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
