import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it, vi } from 'vitest';
import { TeeVerifier } from '../src/llm/tee-verifier';

const MODEL = 'z-ai/glm-5.3-flash';
const KEY = '0x' + '11'.repeat(32);
const OTHER_KEY = '0x' + '22'.repeat(32);
const REQ = 'a'.repeat(64);
const RES = 'b'.repeat(64);

function addressOf(priv: string): string {
  const pub = secp256k1.getPublicKey(priv.slice(2), false);
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

function eip191Sign(text: string, priv: string): string {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(
    new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]),
  );
  const sig = secp256k1.sign(hash, priv.slice(2));
  return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
}

const signature = (chatId: string, { text = `${MODEL}:${REQ}:${RES}`, key = KEY } = {}) => ({
  text,
  signature: eip191Sign(text, key),
  signing_address: addressOf(key),
  signing_algo: 'ecdsa',
  signature_kind: 'provider_tee',
});

const href = (u: Parameters<typeof globalThis.fetch>[0]) =>
  u instanceof Request ? u.url : u.toString();

type Route = (url: URL) => Response | undefined;

function fakeFetch(
  reports: (nonce: string) => { signing_address: string; request_nonce: string }[],
  sig: Route,
) {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(href(input));
    if (url.pathname === '/v1/attestation/report') {
      const nonce = url.searchParams.get('nonce')!;
      return Response.json({
        model_attestations: reports(nonce).map((r) => ({ ...r, signing_algo: 'ecdsa' })),
      });
    }
    return sig(url) ?? new Response('{}', { status: 500 });
  });
}

const attested =
  (...keys: string[]) =>
  (nonce: string) =>
    keys.map((k) => ({ signing_address: addressOf(k), request_nonce: nonce }));
const signs =
  (body: (chatId: string) => unknown): Route =>
  (url) =>
    Response.json(body(url.pathname.split('/').pop()!));

const verifier = (fetch: typeof globalThis.fetch) =>
  new TeeVerifier(fetch, { apiKey: 'sk', model: MODEL, waitMs: 300, retryMs: 20 });
const reply = (chatId: string) => ({ chatId, requestSha256: REQ, responseSha256: RES });

describe('TeeVerifier', () => {
  it('verifies a reply signed by the attested key', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => signature(id)),
    );
    await expect(verifier(fetch).verify([reply('c1')])).resolves.toEqual({
      verified: true,
      reason: null,
      chatIds: ['c1'],
    });
    const [report, sig] = ['/attestation/', '/signature/'].map((p) =>
      fetch.mock.calls.find(([u]) => href(u).includes(p)),
    );
    const att = new URL(href(report![0]));
    expect(att.searchParams.get('model')).toBe(MODEL);
    expect(att.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
    expect(report![1]?.headers).toMatchObject({ 'x-no-aliasing': 'true' });
    expect(href(sig![0])).toBe('https://cloud-api.near.ai/v1/signature/c1?signing_algo=ecdsa');
  });

  it('counts several reports with the same key as one attested key', async () => {
    const fetch = fakeFetch(
      attested(KEY, KEY),
      signs((id) => signature(id)),
    );
    const check = await verifier(fetch).verify([reply('c1'), reply('c2')]);
    expect(check).toMatchObject({ verified: true, chatIds: ['c1', 'c2'] });
  });

  it('refuses a signature over another request hash', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => signature(id, { text: `${MODEL}:${'c'.repeat(64)}:${RES}` })),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({
      verified: false,
      reason: 'signed text does not match the reply',
    });
  });

  it('refuses a signer that no report attests, after refetching the reports once', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => signature(id, { key: OTHER_KEY })),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'signer is not the attested key' });
    const reports = fetch.mock.calls.filter(([u]) => href(u).includes('/attestation/'));
    expect(reports).toHaveLength(2);
  });

  it('refuses a signature whose claimed address is not the recovered signer', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => ({ ...signature(id, { key: OTHER_KEY }), signing_address: addressOf(KEY) })),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'signer is not the attested key' });
  });

  it('refuses a gateway signature', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => ({ ...signature(id), signature_kind: 'gateway' })),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'signature is not from the TEE' });
  });

  it('retries a missing signature, then gives up as unverified', async () => {
    const fetch = fakeFetch(attested(KEY), () => new Response('{}', { status: 404 }));
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'no signature' });
    const tries = fetch.mock.calls.filter(([u]) => href(u).includes('/signature/'));
    expect(tries.length).toBeGreaterThan(1);
  });

  it('takes a signature that appears after a 404', async () => {
    let n = 0;
    const fetch = fakeFetch(attested(KEY), (url) =>
      n++ === 0
        ? new Response('{}', { status: 404 })
        : Response.json(signature(url.pathname.split('/').pop()!)),
    );
    await expect(verifier(fetch).verify([reply('c1')])).resolves.toMatchObject({ verified: true });
  });

  it('retries a server error while the signature is being recorded', async () => {
    let n = 0;
    const fetch = fakeFetch(attested(KEY), (url) =>
      n++ === 0
        ? new Response('busy', { status: 503 })
        : Response.json(signature(url.pathname.split('/').pop()!)),
    );
    await expect(verifier(fetch).verify([reply('c1')])).resolves.toMatchObject({ verified: true });
  });

  it('treats an error_code answer as no signature', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs(() => ({ error_code: 'not_ready', message: 'later' })),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'no signature' });
  });

  it('refuses reports that do not echo our nonce', async () => {
    const fetch = fakeFetch(
      () => [{ signing_address: addressOf(KEY), request_nonce: 'f'.repeat(64) }],
      signs((id) => signature(id)),
    );
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'attestation nonce mismatch' });
  });

  it('is unverified when any one reply fails', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => (id === 'c2' ? signature(id, { key: OTHER_KEY }) : signature(id))),
    );
    const check = await verifier(fetch).verify([reply('c1'), reply('c2')]);
    expect(check).toMatchObject({ verified: false, chatIds: ['c1', 'c2'] });
  });

  it('reuses the reports within their TTL', async () => {
    const fetch = fakeFetch(
      attested(KEY),
      signs((id) => signature(id)),
    );
    const v = verifier(fetch);
    await v.verify([reply('c1')]);
    await v.verify([reply('c2')]);
    const reports = fetch.mock.calls.filter(([u]) => href(u).includes('/attestation/'));
    expect(reports).toHaveLength(1);
  });

  it('is unverified, never throws, when the gateway is down', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('down'));
    const check = await verifier(fetch).verify([reply('c1')]);
    expect(check).toMatchObject({ verified: false, reason: 'attestation unavailable' });
  });
});
