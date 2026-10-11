import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlm, estimateCostUsd, type UsageStore } from './gemini';
import { withFallback } from './fallback';

const schema = z.object({ role: z.string() });
const limits = { enabled: true, maxOutputTokens: 256, dailyCallCap: 2, perUserHourlyCap: 1 };

function memStore(initial = { dailyCalls: 0, userHourlyCalls: 0 }) {
  const state = { ...initial, tokens: [] as Array<[number, number]> };
  const store: UsageStore = {
    counts: async () => ({ dailyCalls: state.dailyCalls, userHourlyCalls: state.userHourlyCalls }),
    reserveCall: async () => {
      state.dailyCalls++;
      state.userHourlyCalls++;
    },
    addTokens: async (_b, i, o) => {
      state.tokens.push([i, o]);
    },
  };
  return { store, state };
}

const okRes = (text: string) => ({
  output_text: text,
  usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 20 },
});

const args = { component: 'intake', userKey: 'u1', system: 'sys', input: 'cook needed', schema };

describe('createLlm guardrails', () => {
  it('kill switch: no store access, no provider call', async () => {
    const create = vi.fn();
    const { store } = memStore();
    const llm = createLlm({ limits: { ...limits, enabled: false }, store, client: { interactions: { create } } });
    expect(await llm.generateStructured(args)).toEqual({ ok: false, reason: 'disabled' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses over the daily cap and per-user hourly cap', async () => {
    const create = vi.fn();
    const client = { interactions: { create } };
    const daily = createLlm({ limits, store: memStore({ dailyCalls: 2, userHourlyCalls: 0 }).store, client });
    expect(await daily.generateStructured(args)).toEqual({ ok: false, reason: 'daily_cap' });
    const user = createLlm({ limits, store: memStore({ dailyCalls: 0, userHourlyCalls: 1 }).store, client });
    expect(await user.generateStructured(args)).toEqual({ ok: false, reason: 'user_cap' });
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the pinned model, token cap, minimal thinking, store=false and JSON schema', async () => {
    const create = vi.fn(async (...args: [Record<string, unknown>]) => {
      void args;
      return okRes('{"role":"cook"}');
    });
    const { store, state } = memStore();
    const llm = createLlm({ limits, store, client: { interactions: { create } } });
    const r = await llm.generateStructured(args);
    expect(r).toMatchObject({ ok: true, data: { role: 'cook' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = create.mock.calls[0]![0] as Record<string, any>;
    expect(params.model).toBe('gemini-3.5-flash-lite');
    expect(params.generation_config).toEqual({ max_output_tokens: 256, thinking_level: 'minimal' });
    expect(params.store).toBe(false);
    expect(params.response_format.mime_type).toBe('application/json');
    expect(params.response_format.schema.properties.role).toBeDefined();
    expect(params.input).toBe('cook needed');
    expect(state.tokens).toEqual([[1000, 120]]);
    if (r.ok) expect(r.usage.estimatedCostUsd).toBeCloseTo(estimateCostUsd(1000, 120));
  });

  it('retries once on a transient error, then succeeds; both attempts count', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { status: 503 }))
      .mockResolvedValueOnce(okRes('{"role":"cook"}'));
    const { store, state } = memStore();
    const llm = createLlm({
      limits: { ...limits, dailyCallCap: 10, perUserHourlyCap: 10 },
      store,
      client: { interactions: { create } },
      sleep: async () => undefined,
    });
    expect((await llm.generateStructured(args)).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(state.dailyCalls).toBe(2);
  });

  it('never retries more than once', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    const llm = createLlm({
      limits: { ...limits, dailyCallCap: 10, perUserHourlyCap: 10 },
      store: memStore().store,
      client: { interactions: { create } },
      sleep: async () => undefined,
    });
    expect(await llm.generateStructured(args)).toEqual({ ok: false, reason: 'provider_error' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 402 }));
    const llm = createLlm({ limits, store: memStore().store, client: { interactions: { create } } });
    expect(await llm.generateStructured(args)).toEqual({ ok: false, reason: 'provider_error' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects schema-invalid output without retrying', async () => {
    for (const bad of ['not json', '{"role":5}', '']) {
      const create = vi.fn(async () => okRes(bad));
      const llm = createLlm({ limits, store: memStore().store, client: { interactions: { create } } });
      expect(await llm.generateStructured(args)).toEqual({ ok: false, reason: 'invalid_output' });
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it('does not spend when caps cannot be verified', async () => {
    const create = vi.fn();
    const store: UsageStore = { ...memStore().store, counts: async () => Promise.reject(new Error('db down')) };
    const llm = createLlm({ limits, store, client: { interactions: { create } } });
    expect(await llm.generateStructured(args)).toEqual({ ok: false, reason: 'provider_error' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('withFallback', () => {
  it('uses the fallback when the LLM fails', () => {
    expect(withFallback({ ok: false, reason: 'disabled' }, () => 'tpl')).toEqual({ value: 'tpl', source: 'fallback' });
    expect(withFallback({ ok: true, data: 'llm' }, () => 'tpl')).toEqual({ value: 'llm', source: 'llm' });
  });
});
