# VYONETIX-SOLUTIONS AI Spend Guard API

## Plans and getting started

Choose a plan on the public RapidAPI listing, then use the endpoint examples below with your RapidAPI key. The listing currently shows these monthly tiers:

| Plan | Price | Monthly request cap | Rate limit |
|---|---:|---:|---:|
| BASIC | $0 | 1,000 | 1,000 requests/hour |
| PRO | $9.99 | 10,000 | 2 requests/second |
| ULTRA | $29.99 | 100,000 | 5 requests/second |
| MEGA | $99.99 | 500,000 | 10 requests/second |

Monthly request limits are hard caps. RapidAPI lists a 10,240 MB monthly bandwidth allowance and US$0.001 per additional MB; its free-plan flow may ask for a payment card. Review the current plan terms before subscribing. These tiers meter API access; they do not enforce runtime model spend. This early-access API has no availability SLA, and its consumer routes still need independent end-to-end verification.


**Purpose:** turn a public AI model rate catalog and a caller's token workload into a traceable USD cost estimate. It helps developers model AI inference unit economics before deploying a workload.

**Availability:** the public RapidAPI listing is live under the VYONETIX SOLUTIONS organization: [Vyonetix AI Spend Guard](https://rapidapi.com/vyonetix-solutions-vyonetix-solutions-default/api/vyonetix-ai-spend-guard). Its current Free BASIC plan shows 1,000 requests/month; the page also retains a legacy BASIC Deprecated card. RapidAPI's health check reports SUCCESS. Consumer signup/card requirements and an independent external route test are not verified; this remains a controlled pilot with no availability SLA.

This is an estimate utility, not an inference gateway, provider invoice, purchasing recommendation, or claim that different models have equal quality. It does not send prompts to model vendors, accept provider keys, or retain workload requests.

## GitHub Actions budget gate (technical preview)

The company also publishes a [Vyonetix AI Spend Guard Budget Gate action](https://github.com/VYONETIX-SOLUTIONS/vyonetix-ai-spend-guard-action). It submits a caller-defined model and token-volume workload to `POST /v1/workloads/estimate`, reports the returned estimate and source timestamps in the workflow summary, and fails the job when the estimate exceeds the configured budget. It does not enforce runtime spend, inspect prompts, or use provider credentials.

The action is a technical preview. Vyonetix has not independently verified this estimate route through a distinct RapidAPI consumer. Treat estimates as pre-deployment scenarios, review current provider rates, and do not make the action a required branch-protection check until your own consumer-path verification succeeds. See the action repository for setup, secret handling, limitations, sample configuration, and its MIT code licence; that licence does not grant a licence to this API service or its data sources.

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
