import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const SECRET = "unit-test-secret-which-is-at-least-32-characters-long";
const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o-test": {
        id: "gpt-4o-test",
        name: "GPT-4o test fixture",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128000, output: 16000 },
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        last_updated: "2026-11-10",
      },
      "tiered-test": {
        id: "tiered-test",
        name: "Tiered fixture",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 256000, output: 32000 },
        cost: { input: 1, output: 2, tiers: [{ input: 3, output: 4 }] },
        last_updated: "2026-11-10",
      },
      "image-only-test": {
        id: "image-only-test",
        name: "Image fixture",
        modalities: { input: ["image"], output: ["image"] },
        cost: { input: 1, output: 2 },
        last_updated: "2026-11-10",
      },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter (excluded fixture)",
    models: {
      "test-model": {
        id: "test-model",
        name: "Excluded",
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.1, output: 0.2 },
      },
    },
  },
};

function authHeaders(extra = {}) {
  return { "X-RapidAPI-Proxy-Secret": SECRET, ...extra };
}

function env() {
  return { RAPIDAPI_PROXY_SECRET: SECRET };
}

test("health is public and reports liveness only", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health"), {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.live, true);
  assert.equal(body.data.source_checked, false);
});

test("data routes reject requests without the gateway secret before fetching the catalog", async () => {
  let fetchCalled = false;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error("must not be called"); };
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/models/prices"), env());
    assert.equal(response.status, 401);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("price listing normalizes text rates, filters providers, and excludes OpenRouter", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/models/prices?provider_id=openai&limit=10", { headers: authHeaders() }), env());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source_metadata.license, "MIT — Copyright (c) 2025 models.dev");
    assert.equal(body.pagination.total, 2);
    assert.equal(body.data.some((row) => row.provider_id === "openrouter"), false);
    assert.equal(body.data.some((row) => row.model_id === "image-only-test"), false);
    assert.deepEqual(body.data.find((row) => row.model_id === "gpt-4o-test").price_usd_per_1m_tokens, {
      input: 2.5,
      output: 10,
      cache_read: 1.25,
      cache_write: null,
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("workload estimate computes cache-adjusted and monthly cost reproducibly", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "Content-Type": "application/json" } });
  const request = new Request("https://worker.example/v1/workloads/estimate", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ scenarios: [{
      provider_id: "openai",
      model_id: "gpt-4o-test",
      input_tokens: 1000,
      output_tokens: 100,
      cached_input_tokens: 400,
      requests_per_month: 1000,
    }] }),
  });
  try {
    const response = await worker.fetch(request, env());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data[0].estimated_cost_per_request_usd, 0.003);
    assert.equal(body.data[0].estimated_monthly_cost_usd, 3);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("invalid cache volumes and context-tier rates are rejected", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "Content-Type": "application/json" } });
  const makeRequest = (scenario) => new Request("https://worker.example/v1/workloads/estimate", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ scenarios: [scenario] }),
  });
  try {
    const invalid = await worker.fetch(makeRequest({ provider_id: "openai", model_id: "gpt-4o-test", input_tokens: 10, output_tokens: 0, cached_input_tokens: 11 }), env());
    assert.equal(invalid.status, 400);
    const tiered = await worker.fetch(makeRequest({ provider_id: "openai", model_id: "tiered-test", input_tokens: 10, output_tokens: 1 }), env());
    assert.equal(tiered.status, 422);
    assert.equal((await tiered.json()).error.code, "complex_price_tiers_unsupported");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("unknown query fields and unsupported routes fail closed", async () => {
  const query = await worker.fetch(new Request("https://worker.example/v1/models/prices?price=free", { headers: authHeaders() }), env());
  const missing = await worker.fetch(new Request("https://worker.example/v1/private-data", { headers: authHeaders() }), env());
  assert.equal(query.status, 400);
  assert.equal(missing.status, 404);
});
