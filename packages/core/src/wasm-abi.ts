import { UnexpectedResponseError } from './errors';
import type { AccountId } from './ids';
import { z } from 'zod';

/**
 * Deployed-contract ABI verification straight from the chain. A NEAR contract's callable surface is the
 * set of functions its WASM module EXPORTS, so the deployed code (`view_code` RPC) is parsed for its export
 * section. This proves a method NAME exists on a given deployment; it does not prove argument shapes.
 * Lives in core because several adapters need it and adapters may not import each other.
 */

/** Minimal JSON-RPC surface; the near-adapter's `NearRpcClient` satisfies it structurally. */
export interface JsonRpcCaller {
  call(method: string, params: unknown, options?: { idempotent?: boolean }): Promise<unknown>;
}

export interface WasmExport {
  readonly name: string;
  readonly kind: 'function' | 'table' | 'memory' | 'global' | 'tag';
}

const KINDS: readonly WasmExport['kind'][] = ['function', 'table', 'memory', 'global', 'tag'];

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new RangeError('unexpected end of WASM module');
    this.offset += 1;
    return b;
  }

  /** Unsigned LEB128, limited to 32 bits (all WASM sizes/indices fit). */
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new RangeError('LEB128 value too large');
    }
  }

  slice(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length)
      throw new RangeError('section exceeds module length');
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

/** Parses the export section (id 7) of a WASM binary. */
export function parseWasmExports(bytes: Uint8Array): WasmExport[] {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new RangeError('not a WASM module (bad magic)');
  }
  const reader = new Reader(bytes);
  reader.offset = 8; // magic + version
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const exports: WasmExport[] = [];
  while (!reader.done) {
    const id = reader.byte();
    const size = reader.u32();
    const body = reader.slice(size);
    if (id !== 7) continue;
    const section = new Reader(body);
    const count = section.u32();
    for (let i = 0; i < count; i += 1) {
      const nameLength = section.u32();
      const name = decoder.decode(section.slice(nameLength));
      const kindByte = section.byte();
      section.u32(); // index
      const kind = KINDS[kindByte];
      if (!kind) throw new RangeError(`unknown export kind ${kindByte}`);
      exports.push({ name, kind });
    }
    return exports;
  }
  throw new RangeError('WASM module has no export section');
}

const viewCodeSchema = z.object({ code_base64: z.string().min(1), hash: z.string().min(1) });

export interface DeployedAbi {
  readonly contractId: AccountId;
  readonly codeHash: string;
  readonly functions: ReadonlySet<string>;
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Fetches the deployed WASM (`query` / `view_code`, final finality) and lists its exported functions. */
export async function fetchDeployedAbi(
  rpc: JsonRpcCaller,
  contractId: AccountId,
): Promise<DeployedAbi> {
  const raw = await rpc.call('query', {
    request_type: 'view_code',
    finality: 'final',
    account_id: contractId,
  });
  const parsed = viewCodeSchema.safeParse(raw);
  if (!parsed.success)
    throw new UnexpectedResponseError(`rpc:view_code ${contractId}`, 'malformed view_code result');
  let exportsList: WasmExport[];
  try {
    exportsList = parseWasmExports(base64ToBytes(parsed.data.code_base64));
  } catch (cause) {
    throw new UnexpectedResponseError(
      `rpc:view_code ${contractId}`,
      'deployed code is not parseable WASM',
      { cause },
    );
  }
  return {
    contractId,
    codeHash: parsed.data.hash,
    functions: new Set(exportsList.filter((e) => e.kind === 'function').map((e) => e.name)),
  };
}

export interface ExportCheck {
  readonly contractId: AccountId;
  readonly codeHash: string;
  readonly missing: readonly string[];
  readonly ok: boolean;
}

/** Checks that every method in `expected` is exported by the deployment. */
export async function checkExportedMethods(
  rpc: JsonRpcCaller,
  contractId: AccountId,
  expected: readonly string[],
): Promise<ExportCheck> {
  const abi = await fetchDeployedAbi(rpc, contractId);
  const missing = expected.filter((m) => !abi.functions.has(m));
  return { contractId, codeHash: abi.codeHash, missing, ok: missing.length === 0 };
}
