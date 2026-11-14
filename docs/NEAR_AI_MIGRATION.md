# Moving the analysis LLM to NEAR AI Cloud — research (14 Nov 2026)

Tickets: #232 (switch the provider and model), #233 (verify the TEE signature of every reply).

**Outcome (D35):** GLM 5.3 Flash with `reasoning_effort: low` passed the measurement (6/6 AI answers, loan first,
$0.0002-0.0003 per analysis); Qwen3.8 27B hit the 45 s deadline; GLM 5.3 and gateway Haiku are not enabled for our
key.

## Why

- The hackathon has a **Privacy & Private AI** track tagged _NEAR AI CLOUD_ and _TEE_ ("confidential computation,
  private finance, AI that protects sensitive data"). Several tracks can be picked per submission, so this adds a track
  on top of Unstoppable DeFi / AI Security & Defense. No separate cash bonus or credits are announced on
  nearhackathon.com; the gain is the track and the story ("a NEAR product on NEAR's own private inference").
- The product story improves too: a wallet's strategy, positions and the AI's advice are financial data. With a TEE
  model neither we nor the GPU operator can read the prompt, and every reply comes with a signature from the enclave
  key that anyone can check.

## What NEAR AI Cloud is (checked against the live API today)

- Gateway `https://cloud-api.near.ai/v1`, **OpenAI-compatible** (`POST /chat/completions` with `tools`, structured
  outputs, reasoning). Bearer key from cloud.near.ai, prepaid credits (card or crypto). No Anthropic Messages API.
- Public catalogue `GET /v1/model/list` (64 models). Two kinds:
  - `verifiable: true` — open-weight models in Intel TDX + NVIDIA TEE (NEAR's own vLLM, or Chutes / Tinfoil TEEs),
    with attestation.
  - `providerType: external` — plain proxies to Anthropic, OpenAI, Google… (`anthropic/claude-haiku-5-5` is there at
    the same $0.10 / $0.50). **Not private, not attested** — routing Haiku through the gateway would not count as
    private AI.
- Verification:
  - `GET /v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<hex32>` (+ header
    `x-no-aliasing: true`) → `model_attestations[]` with `intel_quote`, `nvidia_payload`, `event_log`, `request_nonce`,
    `signing_address`, `signing_algo`.
  - `GET /v1/signature/<chat_id>?signing_algo=ecdsa` → `text`, `signature`, `signing_address`, `signature_kind`. For
    `provider_tee` the text is `<MODEL_ID>:sha256(raw request body):sha256(raw response body)`; the signer is recovered
    with EIP-191 and must equal the `signing_address` of exactly one attested report.
  - Full quote checks (Intel DCAP, RTMR3 replay, MRCONFIGID, NVIDIA evidence) are what `nearai/nearai-cloud-verifier`
    does; anyone can also check a reply at cloud.near.ai/verify.
  - Caveat from the docs: instances of one model share a signing key, so a matching signer does not prove the same
    serving instance.

## Candidates (TEE, with tool calling)

| Model (canonical id)                   | $/M in | $/M out | Context | Features                               | Host             |
| -------------------------------------- | -----: | ------: | ------: | -------------------------------------- | ---------------- |
| `z-ai/glm-5.3-flash`                   |   0.08 |    0.50 |      1M | tools, structured outputs, json, reas. | NEAR vLLM        |
| `Qwen/Qwen3.8-27B`                     |   0.04 |    1.35 |    262K | tools, structured outputs, reasoning   | NEAR vLLM        |
| `Qwen/Qwen3.6-35B-A3B-FP8`             |   0.17 |    1.10 |    262K | tools, structured outputs, json, reas. | NEAR vLLM        |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` |   0.30 |    1.20 |      1M | tools, reasoning (no structured out.)  | NEAR vLLM        |
| `moonshotai/kimi-k2.6`                 |   0.81 |    3.85 |    262K | tools, structured outputs              | Chutes (TEE)     |
| `z-ai/glm-5.3`                         |   1.80 |    5.75 |      1M | tools, reasoning                       | Tinfoil (TEE)    |
| _baseline_ `claude-haiku-5-5`          |   0.10 |    0.50 |      1M | —                                      | Anthropic direct |

## Recommendation

1. **Default `z-ai/glm-5.3-flash`.** It is the only TEE model with tools + structured outputs + JSON mode at Haiku's
   price, served by NEAR's own TEE nodes (shortest attestation chain, no third-party TEE), with a context window that
   fits our worst-case 100K-token run. The spend-cap maths stays the same order.
2. **Measure before switching**, with the existing `compare-models.ts` on the same mainnet wallets as #16: GLM 5.3
   Flash, Qwen3.8-27B, GLM 5.3 (quality ceiling) against Haiku 5.5 as the baseline. Pass bar: every run returns output
   that passes zod on the first try or after the existing repair, the same top picks as Haiku on the test wallets, p95
   latency under the analysis deadline, cost per run ≤ 2× Haiku. Take the cheapest model that passes. If none passes,
   take GLM 5.3 and record why.
3. **Why an open model is acceptable now, unlike D17.** D17 rejected open models for weaker tool use and strict JSON
   at the same price. Since then the safety net has become the whole design: code computes every number, the model only
   ranks and explains, its output goes through zod → policy → `validateCascade`, and any failure falls back to the
   labelled heuristics. A weaker model costs answer quality, never safety. The extra hackathon track and a real privacy
   claim outweigh that, if the measurement in (2) shows the quality holds.
4. **One provider, no Anthropic fallback.** A silent fallback to a non-TEE model would make the privacy claim false.
   The fallback stays the labelled heuristics. `@anthropic-ai/sdk` and `ANTHROPIC_*` go away.
5. **Plain `fetch`, no new LLM SDK.** The signature covers the exact request and response bytes, so the client must
   own them: send `JSON.stringify(body)` once and keep the raw response text. Header `x-no-aliasing: true` and the
   canonical model id, because the id is part of the signed text.
6. **Verify every reply** (step 2 of the migration): fetch the attestation report with a fresh nonce (on start, then
   cached with a TTL), check the echoed nonce, keep `signing_address`; after each completion fetch its signature,
   check both hashes and recover the EIP-191 signer with `@noble/curves` + `@noble/hashes` (both already in the
   tree). The UI shows "Private inference · signed in TEE" with a link to cloud.near.ai/verify for that chat id. Full
   Intel / NVIDIA quote verification in our code is out of scope for the deadline → KNOWN_ISSUES, pointing to the
   official verifier.

## Owner steps (blocking)

- Create a NEAR AI Cloud account, add credits ($10–20 is plenty at these prices), create an API key, put it into the
  local `.env` and the server `.env` as `NEAR_AI_API_KEY`. Delete the Anthropic key from the server afterwards.

## Sources

- https://nearhackathon.com (tracks, rules)
- https://cloud-api.near.ai/v1/model/list (catalogue, prices, features — fetched 14 Nov 2026)
- https://docs.near.ai/cloud/ , https://docs.near.ai/cloud/verification ,
  https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md ,
  https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
- https://github.com/nearai/nearai-cloud-verifier , https://github.com/near-examples/nearai-cloud-verification-example
