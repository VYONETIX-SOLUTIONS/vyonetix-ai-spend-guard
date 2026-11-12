# VYONETIX-SOLUTIONS AI Spend Guard API

**Purpose:** turn a public AI model rate catalog and a caller's token workload into a traceable USD cost estimate. It helps developers model AI inference unit economics before deploying a workload.

**Availability:** this company-owned source repository is public, but the RapidAPI project is still a private draft and has no public consumer endpoint. The RapidAPI host shown in the examples is intended for the listing after publication; it is not currently available for consumer signup or gateway use.

This is an estimate utility, not an inference gateway, provider invoice, purchasing recommendation, or claim that different models have equal quality. It does not send prompts to model vendors, accept provider keys, or retain workload requests.

## API operations

| Operation | Purpose |
|---|---|
| `GET /v1/models/prices` | Filter text-input/text-output models by provider, model ID, or query. Returns listed USD rates per one million text tokens and record update dates. |
| `POST /v1/workloads/estimate` | Calculate per-request and optional monthly cost from token counts and source catalog rates. Accepts up to 20 scenarios. |

`GET /health` is a public liveness check and does not verify the upstream source.

All data operations are protected at the Worker origin by the RapidAPI per-project proxy secret. Consumers authenticate through RapidAPI; do not expose the origin secret in client code.

## Example: find a model rate

```sh
curl --get 'https://vyonetix-ai-spend-guard.p.rapidapi.com/v1/models/prices' \
  --data-urlencode 'provider_id=openai' \
  --data-urlencode 'limit=5' \
  -H "X-RapidAPI-Key: ${RAPIDAPI_KEY}" \
  -H 'X-RapidAPI-Host: vyonetix-ai-spend-guard.p.rapidapi.com' \
  -H 'Accept: application/json'
```

## Example: estimate a workload

```sh
curl --request POST 'https://vyonetix-ai-spend-guard.p.rapidapi.com/v1/workloads/estimate' \
  --header "X-RapidAPI-Key: ${RAPIDAPI_KEY}" \
  --header 'X-RapidAPI-Host: vyonetix-ai-spend-guard.p.rapidapi.com' \
  --header 'Content-Type: application/json' \
  --data '{"scenarios":[{"provider_id":"openai","model_id":"gpt-4o-2024-08-06","input_tokens":12000,"output_tokens":1200,"cached_input_tokens":0,"requests_per_month":10000}]}'
```

The model ID is an example identifier. Query the catalog first and check each result's `source_record_updated_at` before relying on its rates.

## Calculation

```text
USD estimate = (
  uncached_input_tokens × input_rate
  + cached_input_tokens × cache_read_rate
  + cache_write_tokens × cache_write_rate
  + output_tokens × output_rate
) / 1,000,000
```

The request's `cached_input_tokens` and `cache_write_tokens` are portions of `input_tokens`, not additional token volume. If a cache rate is missing, a workload using that cache mode is rejected instead of silently priced at the standard input rate. Models with detected context price tiers are excluded from estimation until tier-aware math is implemented.

## Source, licence, and freshness

- Source dataset: [Models.dev JSON catalog](https://models.dev/api.json?type=all).
- Dataset project: [anomalyco/models.dev](https://github.com/anomalyco/models.dev).
- Licence: [MIT](https://github.com/anomalyco/models.dev/blob/dev/LICENSE), Copyright (c) 2025 models.dev. See `THIRD_PARTY_NOTICES.md`.
- Prices are published in USD per one million tokens. Each response includes the source record's `last_updated` value, retrieval time, source URL, and a 15-minute edge-cache TTL.
- OpenRouter is deliberately excluded as a provider. OpenRouter's own terms prohibit building a competing service from its site or service data; Vyonetix does not query its API.

The catalog may contain older or incomplete price records. Verify rates against the provider's current pricing page before making a production commitment. The API reports source facts and arithmetic; it does not claim price equivalence by model quality, latency, availability, regional routing, contract discounts, or billing outcome.

## Exclusions

This version estimates text input, output, and explicitly provided cache token categories. It excludes provider/account discounts, long-context or other tier rules, batch prices, tools, images, audio, video, network fees, retries, taxes, and minimum charges. Cost comparisons do not recommend a model or say two models are interchangeable.

## Privacy and limits

- Requests contain only provider/model IDs and integer token counts. Do not submit prompts, customer identifiers, provider credentials, or private telemetry.
- The Worker does not log request bodies or persist workload scenarios. `POST` responses use `Cache-Control: no-store`.
- A request may contain at most 20 scenarios and 24 KB; each token count is bounded at five million.
- No availability SLA is offered. `/health` reports Worker liveness only.

## Licence

The Models.dev dataset is used under MIT and is attributed in API responses. This notice applies to that upstream dataset. The Vyonetix service implementation has no additional licence grant in this repository.
