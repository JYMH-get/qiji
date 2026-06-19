import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSettingsStore, type Channel } from "@/store/settingsStore";
import { syncChannelAdapters } from "./channelAdapter";
import { getAdapter } from "./registry";

describe("channelAdapter Custom Request & Placeholders", () => {
  const mockChannel: Channel = {
    id: "ch-test-1",
    name: "Test Channel",
    baseUrl: "https://api.test-ai.com/v1",
    apiKey: "test-api-key",
    models: ["gpt-test-model", "flux-test-image"],
  };

  const originalFetch = global.fetch;
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    // Clear and set settings store
    useSettingsStore.setState({
      channels: [mockChannel],
      modelRequests: {},
      requestTemplates: [],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should register dynamic adapters correctly", () => {
    syncChannelAdapters();
    const adapter1 = getAdapter("ch-test-1:gpt-test-model");
    const adapter2 = getAdapter("ch-test-1:flux-test-image");

    expect(adapter1).toBeDefined();
    expect(adapter2).toBeDefined();
    expect(adapter1?.displayName).toBe("gpt-test-model");
    expect(adapter2?.displayName).toBe("flux-test-image");
  });

  it("should execute default chat completions API request by default", async () => {
    syncChannelAdapters();
    const adapter = getAdapter("ch-test-1:gpt-test-model");
    
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: "Default response text" } }]
      }),
      clone() {
        return this;
      }
    } as unknown as Response);

    const result = await adapter?.submit(
      { prompt: "Hello AI", _nodeId: "node-1" },
      { temperature: 0.5, maxTokens: 100 },
      "text"
    );

    expect(result).toEqual({ taskId: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.test-ai.com/v1/v1/chat/completions");
    expect(calledOptions.method).toBe("POST");
    expect(calledOptions.headers).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer test-api-key"
    });
    
    const parsedBody = JSON.parse(calledOptions.body);
    expect(parsedBody).toEqual({
      model: "gpt-test-model",
      messages: [{ role: "user", content: "Hello AI" }],
      temperature: 0.5,
      max_tokens: 100
    });
  });

  it("should execute custom requests with placeholders and custom headers", async () => {
    // Set up custom configuration for the test model
    useSettingsStore.setState({
      modelRequests: {
        "ch-test-1:gpt-test-model": {
          requestType: "custom",
          method: "PUT",
          url: "/custom/chat/v2",
          headers: {
            "X-Custom-Client": "Qiji-App",
            "Authorization": "Bearer custom-token-override"
          },
          bodyTemplate: `{
            "model_id": "{{model}}",
            "prompt_text": "{{input}}",
            "config": {
              "temp": {{temperature}},
              "max_t": {{maxTokens}}
            }
          }`
        }
      }
    });

    syncChannelAdapters();
    const adapter = getAdapter("ch-test-1:gpt-test-model");
    
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: "Custom response text" } }]
      }),
      clone() {
        return this;
      }
    } as unknown as Response);

    await adapter?.submit(
      { prompt: 'Hello "AI" Partner', _nodeId: "node-2" },
      { temperature: 0.8, maxTokens: 512 },
      "text"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];
    // Relative url appended to channel baseUrl
    expect(calledUrl).toBe("https://api.test-ai.com/v1/custom/chat/v2");
    expect(calledOptions.method).toBe("PUT");
    
    // Headers merged, overrides default Authorization
    expect(calledOptions.headers).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer custom-token-override",
      "X-Custom-Client": "Qiji-App"
    });

    const parsedBody = JSON.parse(calledOptions.body);
    expect(parsedBody).toEqual({
      model_id: "gpt-test-model",
      prompt_text: 'Hello "AI" Partner',
      config: {
        temp: 0.8,
        max_t: 512
      }
    });
  });

  it("should support absolute URLs in custom request configuration", async () => {
    useSettingsStore.setState({
      modelRequests: {
        "ch-test-1:gpt-test-model": {
          requestType: "custom",
          method: "POST",
          url: "https://independent-endpoint.com/generate",
          headers: {},
          bodyTemplate: `{"input": "{{input}}"}`
        }
      }
    });

    syncChannelAdapters();
    const adapter = getAdapter("ch-test-1:gpt-test-model");

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: "Absolute url response" } }]
      }),
      clone() {
        return this;
      }
    } as unknown as Response);

    await adapter?.submit(
      { prompt: "Simple Input", _nodeId: "node-3" },
      {},
      "text"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://independent-endpoint.com/generate");
  });
});
