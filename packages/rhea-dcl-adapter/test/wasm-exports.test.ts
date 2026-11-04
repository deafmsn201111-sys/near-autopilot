import { accountId } from '@near-autopilot/core';
import { describe, expect, it } from 'vitest';
import { fetchDeployedAbi, parseWasmExports, verifyDeployedAbi, type JsonRpcCaller } from '../src';

function leb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** Builds a tiny but structurally valid WASM module whose export section lists the given functions. */
function wasmWithExports(
  names: string[],
  extra: { name: string; kind: number }[] = [],
): Uint8Array {
  const entries: number[] = [];
  const all = [...names.map((name) => ({ name, kind: 0 })), ...extra];
  for (const [i, e] of all.entries()) {
    const nameBytes = [...new TextEncoder().encode(e.name)];
    entries.push(...leb(nameBytes.length), ...nameBytes, e.kind, ...leb(i));
  }
  const exportBody = [...leb(all.length), ...entries];
  const customBody = [...leb(4), ...new TextEncoder().encode('name')]; // a custom section before exports
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...leb(customBody.length),
    ...customBody,
    0x07,
    ...leb(exportBody.length),
    ...exportBody,
  ]);
}

function rpcReturning(bytes: Uint8Array, hash = 'HASH'): JsonRpcCaller & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      return { code_base64: Buffer.from(bytes).toString('base64'), hash };
    },
  };
}

describe('parseWasmExports', () => {
  it('reads function and memory exports, skipping earlier sections', () => {
    const exported = parseWasmExports(
      wasmWithExports(['get_pool', 'quote'], [{ name: 'memory', kind: 2 }]),
    );
    expect(exported).toEqual([
      { name: 'get_pool', kind: 'function' },
      { name: 'quote', kind: 'function' },
      { name: 'memory', kind: 'memory' },
    ]);
  });

  it('handles multi-byte LEB128 lengths', () => {
    const long = 'm'.repeat(200);
    expect(parseWasmExports(wasmWithExports([long]))[0]?.name).toBe(long);
  });

  it('rejects non-WASM input and modules without exports', () => {
    expect(() => parseWasmExports(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(RangeError);
    expect(() => parseWasmExports(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toThrow(
      RangeError,
    );
  });
});

describe('verifyDeployedAbi', () => {
  const contract = accountId('dclv2.ref-dev.testnet');

  it('requests view_code at final finality and lists exported functions', async () => {
    const rpc = rpcReturning(wasmWithExports(['get_pool']));
    const abi = await fetchDeployedAbi(rpc, contract);
    expect(rpc.calls).toEqual([
      {
        method: 'query',
        params: { request_type: 'view_code', finality: 'final', account_id: contract },
      },
    ]);
    expect(abi.codeHash).toBe('HASH');
    expect([...abi.functions]).toEqual(['get_pool']);
  });

  it('reports exactly which expected methods are missing', async () => {
    const rpc = rpcReturning(wasmWithExports(['get_pool', 'quote', 'add_liquidity']));
    const result = await verifyDeployedAbi(rpc, contract, {
      views: ['get_pool', 'list_pools'],
      calls: ['add_liquidity', 'remove_liquidity'],
    });
    expect(result.missingViewMethods).toEqual(['list_pools']);
    expect(result.missingCallMethods).toEqual(['remove_liquidity']);
    expect(result.ok).toBe(false);
  });

  it('passes when everything expected is exported', async () => {
    const rpc = rpcReturning(wasmWithExports(['a', 'b']));
    expect((await verifyDeployedAbi(rpc, contract, { views: ['a'], calls: ['b'] })).ok).toBe(true);
  });

  it('fails closed on malformed RPC output', async () => {
    const rpc: JsonRpcCaller = { call: async () => ({ nope: true }) };
    await expect(fetchDeployedAbi(rpc, contract)).rejects.toThrow('malformed view_code result');
    const junk: JsonRpcCaller = {
      call: async () => ({
        code_base64: Buffer.from('not wasm at all').toString('base64'),
        hash: 'h',
      }),
    };
    await expect(fetchDeployedAbi(junk, contract)).rejects.toThrow('not parseable WASM');
  });
});
