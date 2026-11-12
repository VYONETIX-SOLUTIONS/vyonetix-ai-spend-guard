const SERVICE = "vyonetix-ai-spend-guard";
const VERSION = "0.1.0";
const SOURCE_URL = "https://models.dev/api.json?type=all";
const SOURCE_NAME = "Models.dev";
const SOURCE_LICENSE = "MIT — Copyright (c) 2025 models.dev";
const SOURCE_LICENSE_URL = "https://github.com/anomalyco/models.dev/blob/dev/LICENSE";
const CACHE_SECONDS = 900;
const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_SCENARIOS = 20;
const MAX_TOKEN_COUNT = 5_000_000;

let memoryCatalog = null;

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function errorResponse(status, code, message, details) {
  return jsonResponse({
    status: "error",
    service: SERVICE,
    version: VERSION,
    error: { code, message, ...(details ? { details } : {}) },
  }, status);
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function finiteRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function sourceMetadata(retrievedAt, sourceCheckedAt) {
  return {
    provenance: `${SOURCE_NAME} public model catalog`,
    source_url: SOURCE_URL,
    license: SOURCE_LICENSE,
    license_url: SOURCE_LICENSE_URL,
    freshness: {
      retrieved_at: retrievedAt,
      source_record_updated_at: sourceCheckedAt || null,
      edge_cache_ttl_seconds: CACHE_SECONDS,
    },
  };
}

function cacheKey(requestUrl) {
  const url = new URL("/__internal/models-dev-catalog-v1", requestUrl);
  return new Request(url.toString(), { method: "GET" });
}

async function readCache(requestUrl) {
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  try {
    const response = await cache.match(cacheKey(requestUrl));
    if (!response) return null;
    const entry = await response.json();
    if (entry && entry.payload && typeof entry.fetched_at === "string") return entry;
  } catch (_) {
    return null;
  }
  return null;
}

async function writeCache(requestUrl, entry) {
  const cache = globalThis.caches?.default;
  if (!cache) return;
  try {
    await cache.put(cacheKey(requestUrl), new Response(JSON.stringify(entry), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    }));
  } catch (_) {
    // The per-isolate cache still limits repeat upstream reads when Cache API is unavailable.
  }
}

async function loadCatalog(requestUrl) {
  const now = Date.now();
  if (memoryCatalog && memoryCatalog.expires_at > now) return memoryCatalog.entry;

  const edgeEntry = await readCache(requestUrl);
  if (edgeEntry) {
    memoryCatalog = { entry: edgeEntry, expires_at: now + 60_000 };
    return edgeEntry;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response;
  try {
    response = await fetch(SOURCE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Vyonetix-AISpendGuard/0.1 (+https://github.com/VYONETIX-SOLUTIONS)",
      },
      signal: controller.signal,
    });
  } catch (_) {
    clearTimeout(timeout);
    throw new Error("source_unavailable");
  }
  clearTimeout(timeout);

  if (!response.ok) throw new Error("source_unavailable");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error("source_payload_too_large");

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (_) {
    throw new Error("source_unavailable");
  }
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error("source_payload_too_large");

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    throw new Error("source_invalid_json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("source_invalid_schema");

  const entry = { fetched_at: new Date().toISOString(), payload };
  memoryCatalog = { entry, expires_at: Date.now() + 60_000 };
  await writeCache(requestUrl, entry);
  return entry;
}

function textRateCard(providerId, provider, modelId, model) {
  if (!model || !model.cost || !model.modalities) return null;
  const inputModalities = Array.isArray(model.modalities.input) ? model.modalities.input : [];
  const outputModalities = Array.isArray(model.modalities.output) ? model.modalities.output : [];
  if (!inputModalities.includes("text") || !outputModalities.includes("text")) return null;

  const input = finiteRate(model.cost.input);
  const output = finiteRate(model.cost.output);
  if (input === null || output === null) return null;

  const costComplexity = Boolean(
    (Array.isArray(model.cost.tiers) && model.cost.tiers.length > 0)
    || model.cost.context_over_200k
    || model.cost.context_over_128k
    || model.cost.context_over_32k
  );

  return {
    provider_id: providerId,
    provider_name: typeof provider.name === "string" ? provider.name : providerId,
    model_id: typeof model.id === "string" ? model.id : modelId,
    model_name: typeof model.name === "string" ? model.name : modelId,
    currency: "USD",
    unit: "USD per 1,000,000 text tokens",
    price_usd_per_1m_tokens: {
      input,
      output,
      cache_read: finiteRate(model.cost.cache_read),
      cache_write: finiteRate(model.cost.cache_write),
    },
    limits: {
      context_tokens: safeInteger(model.limit?.context, 0, Number.MAX_SAFE_INTEGER) ? model.limit.context : null,
      output_tokens: safeInteger(model.limit?.output, 0, Number.MAX_SAFE_INTEGER) ? model.limit.output : null,
    },
    modalities: { input: inputModalities, output: outputModalities },
    open_weights: typeof model.open_weights === "boolean" ? model.open_weights : null,
    release_date: typeof model.release_date === "string" ? model.release_date : null,
    source_record_updated_at: typeof model.last_updated === "string" ? model.last_updated : null,
    has_complex_price_tiers: costComplexity,
  };
}

function getRateCards(catalog) {
  const rows = [];
  for (const [providerId, provider] of Object.entries(catalog || {})) {
    if (providerId.toLowerCase() === "openrouter") continue;
    if (!provider || !provider.models || typeof provider.models !== "object") continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      const row = textRateCard(providerId, provider, modelId, model);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.model_id.localeCompare(b.model_id));
  return rows;
}

function parseListQuery(url) {
  const allowed = new Set(["provider_id", "model_id", "q", "limit", "offset"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return { error: "unknown_query_parameter", key };
  }
  const providerId = url.searchParams.get("provider_id")?.trim().toLowerCase() || "";
  const modelId = url.searchParams.get("model_id")?.trim().toLowerCase() || "";
  const query = url.searchParams.get("q")?.trim().toLowerCase() || "";
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (providerId.length > 64 || !/^[a-z0-9_-]*$/.test(providerId)) return { error: "invalid_provider_id" };
  if (modelId.length > 180 || /[\u0000-\u001f]/.test(modelId)) return { error: "invalid_model_id" };
  if (query.length > 120 || /[\u0000-\u001f]/.test(query)) return { error: "invalid_query" };
  if (!safeInteger(limit, 1, 100)) return { error: "invalid_limit" };
  if (!safeInteger(offset, 0, 100_000)) return { error: "invalid_offset" };
  return { value: { providerId, modelId, query, limit, offset } };
}

async function listPrices(url, requestUrl) {
  const filters = parseListQuery(url);
  if (filters.error) return errorResponse(400, filters.error, "The query parameters are invalid.");
  let entry;
  try {
    entry = await loadCatalog(requestUrl);
  } catch (error) {
    const code = error?.message || "source_unavailable";
    const status = code === "source_unavailable" ? 502 : 503;
    return errorResponse(status, code, "The model catalog could not be read safely. Retry later.");
  }

  const allRows = getRateCards(entry.payload);
  const { providerId, modelId, query, limit, offset } = filters.value;
  const rows = allRows.filter((row) => {
    if (providerId && row.provider_id.toLowerCase() !== providerId) return false;
    if (modelId && row.model_id.toLowerCase() !== modelId) return false;
    if (query && !`${row.provider_id} ${row.provider_name} ${row.model_id} ${row.model_name}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const data = rows.slice(offset, offset + limit);
  const checkedAt = data.reduce((latest, row) => row.source_record_updated_at && row.source_record_updated_at > latest ? row.source_record_updated_at : latest, "");
  return jsonResponse({
    status: "success",
    service: SERVICE,
    version: VERSION,
    endpoint: "model_prices",
    checked_at: new Date().toISOString(),
    source_metadata: sourceMetadata(entry.fetched_at, checkedAt),
    pagination: { limit, offset, total: rows.length, has_more: offset + data.length < rows.length },
    data,
  }, 200, { "Cache-Control": "no-store" });
}

async function readBoundedJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return { error: "request_too_large" };
  if (!request.body) return { error: "invalid_json" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { error: "request_too_large" };
      }
      chunks.push(value);
    }
  } catch (_) {
    return { error: "invalid_json" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) };
  } catch (_) {
    return { error: "invalid_json" };
  }
}

function validateScenario(scenario, index) {
  const allowed = new Set(["provider_id", "model_id", "input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens", "requests_per_month"]);
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return { error: "invalid_scenario", index };
  for (const key of Object.keys(scenario)) if (!allowed.has(key)) return { error: "unknown_scenario_field", index, field: key };
  if (typeof scenario.provider_id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(scenario.provider_id)) return { error: "invalid_provider_id", index };
  if (typeof scenario.model_id !== "string" || scenario.model_id.length < 1 || scenario.model_id.length > 180 || /[\u0000-\u001f]/.test(scenario.model_id)) return { error: "invalid_model_id", index };
  for (const key of ["input_tokens", "output_tokens"]) {
    if (!safeInteger(scenario[key], 0, MAX_TOKEN_COUNT)) return { error: "invalid_token_count", index, field: key };
  }
  const cached = scenario.cached_input_tokens ?? 0;
  const cacheWrite = scenario.cache_write_tokens ?? 0;
  if (!safeInteger(cached, 0, MAX_TOKEN_COUNT) || !safeInteger(cacheWrite, 0, MAX_TOKEN_COUNT)) return { error: "invalid_cache_token_count", index };
  if (cached + cacheWrite > scenario.input_tokens) return { error: "cache_tokens_exceed_input_tokens", index };
  if (scenario.requests_per_month !== undefined && !safeInteger(scenario.requests_per_month, 0, 10_000_000)) return { error: "invalid_requests_per_month", index };
  return { value: {
    provider_id: scenario.provider_id.toLowerCase(),
    model_id: scenario.model_id,
    input_tokens: scenario.input_tokens,
    output_tokens: scenario.output_tokens,
    cached_input_tokens: cached,
    cache_write_tokens: cacheWrite,
    requests_per_month: scenario.requests_per_month,
  } };
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

async function estimateWorkloads(request, requestUrl) {
  const parsed = await readBoundedJson(request);
  if (parsed.error) {
    const status = parsed.error === "request_too_large" ? 413 : 400;
    return errorResponse(status, parsed.error, parsed.error === "request_too_large" ? "The request body exceeds the 24 KB limit." : "A valid JSON request body is required.");
  }
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "scenarios")) return errorResponse(400, "invalid_request", "The request must contain only a scenarios array.");
  if (!Array.isArray(body.scenarios) || body.scenarios.length < 1 || body.scenarios.length > MAX_SCENARIOS) return errorResponse(400, "invalid_scenarios", `Provide between 1 and ${MAX_SCENARIOS} scenarios.`);
  const scenarios = [];
  for (let i = 0; i < body.scenarios.length; i += 1) {
    const result = validateScenario(body.scenarios[i], i);
    if (result.error) return errorResponse(400, result.error, "One or more workload scenarios are invalid.", { index: result.index, field: result.field });
    scenarios.push(result.value);
  }

  let entry;
  try {
    entry = await loadCatalog(requestUrl);
  } catch (error) {
    const code = error?.message || "source_unavailable";
    return errorResponse(code === "source_unavailable" ? 502 : 503, code, "The model catalog could not be read safely. Retry later.");
  }

  const rates = getRateCards(entry.payload);
  const resultRows = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const rate = rates.find((row) => row.provider_id === scenario.provider_id && row.model_id === scenario.model_id);
    if (!rate) return errorResponse(422, "model_rate_not_found", "A scenario model has no supported text input/output rate in the current source catalog.", { index });
    if (rate.has_complex_price_tiers) return errorResponse(422, "complex_price_tiers_unsupported", "This model has additional price tiers that this estimate does not model. Use the source record for detail.", { index, provider_id: rate.provider_id, model_id: rate.model_id });
    const prices = rate.price_usd_per_1m_tokens;
    if (scenario.cached_input_tokens > 0 && prices.cache_read === null) return errorResponse(422, "cache_read_rate_unavailable", "The source catalog does not provide a cache-read rate for this model.", { index });
    if (scenario.cache_write_tokens > 0 && prices.cache_write === null) return errorResponse(422, "cache_write_rate_unavailable", "The source catalog does not provide a cache-write rate for this model.", { index });
    const uncachedInput = scenario.input_tokens - scenario.cached_input_tokens - scenario.cache_write_tokens;
    const components = {
      uncached_input_usd: uncachedInput * prices.input / 1_000_000,
      cache_read_usd: scenario.cached_input_tokens * (prices.cache_read || 0) / 1_000_000,
      cache_write_usd: scenario.cache_write_tokens * (prices.cache_write || 0) / 1_000_000,
      output_usd: scenario.output_tokens * prices.output / 1_000_000,
    };
    const perRequest = Object.values(components).reduce((sum, amount) => sum + amount, 0);
    const result = {
      scenario_index: index,
      provider_id: rate.provider_id,
      provider_name: rate.provider_name,
      model_id: rate.model_id,
      model_name: rate.model_name,
      currency: "USD",
      token_usage: {
        input_tokens: scenario.input_tokens,
        cached_input_tokens: scenario.cached_input_tokens,
        cache_write_tokens: scenario.cache_write_tokens,
        uncached_input_tokens: uncachedInput,
        output_tokens: scenario.output_tokens,
      },
      estimated_cost_per_request_usd: roundUsd(perRequest),
      cost_components_usd: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, roundUsd(value)])),
      source_record_updated_at: rate.source_record_updated_at,
    };
    if (scenario.requests_per_month !== undefined) {
      result.requests_per_month = scenario.requests_per_month;
      result.estimated_monthly_cost_usd = roundUsd(perRequest * scenario.requests_per_month);
    }
    resultRows.push(result);
  }

  return jsonResponse({
    status: "success",
    service: SERVICE,
    version: VERSION,
    endpoint: "workload_cost_estimate",
    checked_at: new Date().toISOString(),
    source_metadata: sourceMetadata(entry.fetched_at),
    calculation: {
      formula: "((input_tokens - cached_input_tokens - cache_write_tokens) * input_rate + cached_input_tokens * cache_read_rate + cache_write_tokens * cache_write_rate + output_tokens * output_rate) / 1,000,000",
      price_unit: "USD per 1,000,000 text tokens",
      limitations: [
        "Estimates use the source catalog's listed USD rates, not a provider invoice or account-specific discount.",
        "Provider tier, context-window, batch, regional, tool, image, audio, video, retry, tax, and network charges are not included.",
        "Cost comparisons do not claim equal model quality, latency, availability, or suitability.",
      ],
    },
    data: resultRows,
  }, 200, { "Cache-Control": "no-store" });
}

async function health() {
  return jsonResponse({
    status: "success",
    service: SERVICE,
    version: VERSION,
    endpoint: "health",
    checked_at: new Date().toISOString(),
    data: { live: true, source_checked: false },
  }, 200, { "Cache-Control": "no-store" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return health();
    if (url.pathname !== "/v1/models/prices" && url.pathname !== "/v1/workloads/estimate") return errorResponse(404, "not_found", "The requested endpoint does not exist.");
    if (url.pathname === "/v1/models/prices" && request.method !== "GET") return errorResponse(405, "method_not_allowed", "Use GET for this endpoint.");
    if (url.pathname === "/v1/workloads/estimate" && request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST for this endpoint.");

    const expected = typeof env?.RAPIDAPI_PROXY_SECRET === "string" ? env.RAPIDAPI_PROXY_SECRET : "";
    if (expected.length < 32) return errorResponse(503, "service_not_configured", "The API gateway credential is not configured safely.");
    const supplied = request.headers.get("X-RapidAPI-Proxy-Secret") || "";
    if (!secureEqual(supplied, expected)) return errorResponse(401, "unauthorized", "Use the authorized API gateway.");

    if (url.pathname === "/v1/models/prices") return listPrices(url, request.url);
    return estimateWorkloads(request, request.url);
  },
};

export const __test = { getRateCards, parseListQuery, roundUsd, validateScenario };
