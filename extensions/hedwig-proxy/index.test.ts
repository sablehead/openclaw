import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type CapturedTool = {
  name: string;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[]; details?: unknown }>;
};

function loadTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const api = {
    registerTool: (tool: unknown) => {
      captured = tool as CapturedTool;
    },
    // The feedback wiring (registerHedwigFeedback) also runs in register(); stub
    // the surfaces it touches so this calendar_create test stays focused.
    runtime: {
      state: {
        openKeyedStore: () => ({ register: async () => {}, lookup: async () => undefined }),
      },
    },
    on: () => {},
    registerInteractiveHandler: () => {},
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  if (!captured) {
    throw new Error("calendar_create not registered");
  }
  return captured;
}

describe("hedwig-proxy calendar_create", () => {
  const origBase = process.env.HEDWIG_CAL_BASE;
  const origToken = process.env.HEDWIG_CAL_TOKEN;

  beforeEach(() => {
    process.env.HEDWIG_CAL_BASE = "https://proxy.example";
    process.env.HEDWIG_CAL_TOKEN = "tok-123";
  });
  afterEach(() => {
    process.env.HEDWIG_CAL_BASE = origBase;
    process.env.HEDWIG_CAL_TOKEN = origToken;
    vi.unstubAllGlobals();
  });

  it("posts to /events with bearer header and a json body (token never in the url)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        created: true,
        id: "ev1",
        report: "「歯医者」を7月1日 14:00に登録しました。",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = loadTool();
    const out = await tool.execute("call-1", { title: "歯医者", start: "2026-07-01T14:00" });

    expect(tool.name).toBe("calendar_create");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.example/events");
    expect(url).not.toContain("tok-123"); // token rides the header, not the URL
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toMatchObject({
      title: "歯医者",
      start: "2026-07-01T14:00",
    });
    // Server-confirmed report relayed verbatim.
    expect(out.content[0].text).toBe("「歯医者」を7月1日 14:00に登録しました。");
  });

  it("reports an honest failure when the server does not confirm success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "upstream error" }) })),
    );
    const tool = loadTool();
    const out = await tool.execute("call-2", { title: "x", start: "2026-07-01T14:00" });
    expect(out.content[0].text).toBe("カレンダーに登録できませんでした。");
  });

  it("reports an honest failure when the request throws (timeout / unreachable proxy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    const tool = loadTool();
    const out = await tool.execute("call-4", { title: "x", start: "2026-07-01T14:00" });
    expect(out.content[0].text).toBe("カレンダーに登録できませんでした。");
  });

  it("is unavailable (no fetch) when the proxy env is missing", async () => {
    delete process.env.HEDWIG_CAL_BASE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = loadTool();
    const out = await tool.execute("call-3", { title: "x", start: "2026-07-01T14:00" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.content[0].text).toContain("利用できません");
  });
});
