import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, 'apps/analytics/public/token-icons/ref');
const manifestPath = path.join(root, 'apps/analytics/lib/ref-token-icons.json');
const tokenListUrl = 'https://api.ref.finance/list-token';
const rpcUrl = process.env.REF_TOKEN_RPC_URL ?? 'https://rpc.mainnet.fastnear.com';
const whitelistContract = 'v2.ref-finance.near';
const maxBytes = 400_000;
const allowedHosts = new Set([
  'ref-new-1.s3.amazonaws.com',
  'storage.herewallet.app',
  'image.mitte.gg',
  'runeshot-files.runemine.com',
  'metadata.runemine.com',
  'maroon-adorable-panther-740.mypinata.cloud',
]);

const rpc = async (accountId, methodName) => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `ref-token-icons-${methodName}`,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from('{}').toString('base64'),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`NEAR RPC error: ${JSON.stringify(json.error)}`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8'));
};

async function mapLimit(items, concurrency, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await fn(items[index]);
      }
    }),
  );
  return output;
}

function sanitizeSvg(bytes) {
  let svg = bytes.toString('utf8');
  svg = svg.replace(/<!DOCTYPE\s+svg\b[^>]*>/i, '').replace(/<\?xml[^>]*\?>/i, '');
  if (!/<svg[\s>]/i.test(svg)) return null;
  if (
    /<script\b|<foreignObject\b|<iframe\b|<!ENTITY|<!DOCTYPE/i.test(svg) ||
    /\bon[a-z]+\s*=/i.test(svg) ||
    /(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:text\/html)/i.test(svg) ||
    /url\(\s*["']?\s*(?:https?:|\/\/|javascript:)/i.test(svg)
  )
    return null;
  return Buffer.from(svg);
}

function imageType(bytes, claimedType = '') {
  const prefix = bytes.subarray(0, 16).toString('ascii').trimStart().toLowerCase();
  if (prefix.startsWith('<svg') || prefix.startsWith('<?xml')) return 'svg';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp';
  if (claimedType === 'image/svg+xml')
    return /<svg[\s>]/i.test(bytes.toString('utf8')) ? 'svg' : null;
  return null;
}

async function loadIcon(icon) {
  if (typeof icon !== 'string' || !icon) return null;
  let bytes;
  let claimedType = '';
  if (icon.startsWith('data:')) {
    const match = icon.match(/^data:(image\/(?:svg\+xml|png|jpeg|webp));base64,([a-z\d+/=]+)$/i);
    if (!match) return null;
    claimedType = match[1].toLowerCase();
    bytes = Buffer.from(match[2], 'base64');
  } else {
    let url;
    try {
      url = new URL(icon);
    } catch {
      return null;
    }
    const ipfsHost = /^[a-z\d-]+\.ipfs\.nftstorage\.link$/i.test(url.hostname);
    if (url.protocol !== 'https:' || (!allowedHosts.has(url.hostname) && !ipfsHost)) return null;
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    claimedType = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > maxBytes) return null;
    const array = await response.arrayBuffer();
    if (array.byteLength > maxBytes) return null;
    bytes = Buffer.from(array);
  }
  if (!bytes.length || bytes.length > maxBytes) return null;
  const extension = imageType(bytes, claimedType);
  if (!extension) return null;
  if (extension === 'svg') {
    bytes = sanitizeSvg(bytes);
    if (!bytes) return null;
  }
  return { bytes, extension };
}

const [whitelist, tokenList] = await Promise.all([
  rpc(whitelistContract, 'get_whitelisted_tokens'),
  fetch(tokenListUrl, { signal: AbortSignal.timeout(20_000) }).then(async (response) => {
    if (!response.ok) throw new Error(`Ref token list returned HTTP ${response.status}`);
    return response.json();
  }),
]);
if (!Array.isArray(whitelist) || whitelist.some((token) => typeof token !== 'string'))
  throw new Error('Ref whitelist response is malformed');

// The token list contains thousands of unverified user tokens. Only query logos for the exchange contract's
// on-chain global whitelist; when its list lacks a logo, try the whitelisted token's own NEP-148 metadata.
const results = await mapLimit(whitelist, 6, async (token) => {
  let metadata = tokenList[token];
  if (!metadata?.icon) {
    try {
      metadata = await rpc(token, 'ft_metadata');
    } catch {
      // Some old bridged contracts do not expose NEP-148 metadata; they remain on the letter fallback.
    }
  }
  const asset = await loadIcon(metadata?.icon).catch(() => null);
  return { token, asset };
});

await mkdir(outputDir, { recursive: true });
for (const entry of await readdir(outputDir))
  await rm(path.join(outputDir, entry), { recursive: true });
const icons = {};
for (const { token, asset } of results) {
  if (!asset) continue;
  const filename = `${createHash('sha256').update(token).digest('hex').slice(0, 24)}.${asset.extension}`;
  await writeFile(path.join(outputDir, filename), asset.bytes);
  icons[token] = `/token-icons/ref/${filename}`;
}
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      source: `${whitelistContract}.get_whitelisted_tokens ∩ api.ref.finance/list-token + NEP-148 icon`,
      updatedAt: new Date().toISOString(),
      whitelistedTokens: whitelist.length,
      icons,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Ref global whitelist: ${whitelist.length} tokens; local logos: ${Object.keys(icons).length}.`,
);
console.log(
  `No icon available or invalid for ${whitelist.length - Object.keys(icons).length} whitelisted tokens.`,
);
