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

function loadTool(name: string): CapturedTool {
  const captured: CapturedTool[] = [];
  const api = {
    registerTool: (tool: unknown) => {
      captured.push(tool as CapturedTool);
    },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  const tool = captured.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`${name} not registered`);
  }
  return tool;
}

describe("hedwig-proxy calendar tools", () => {
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

  it("calendar_create posts to /events with bearer header and a json body (token never in the url)", async () => {
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

    const tool = loadTool("calendar_create");
    const out = await tool.execute("call-1", { title: "歯医者", start: "2026-07-01T14:00" });

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

  it("calendar_create reports an honest failure when the server does not confirm success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "upstream error" }) })),
    );
    const tool = loadTool("calendar_create");
    const out = await tool.execute("call-2", { title: "x", start: "2026-07-01T14:00" });
    expect(out.content[0].text).toBe("カレンダーに登録できませんでした。");
  });

  it("calendar_create reports an honest failure when the request throws (timeout / unreachable proxy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    const tool = loadTool("calendar_create");
    const out = await tool.execute("call-4", { title: "x", start: "2026-07-01T14:00" });
    expect(out.content[0].text).toBe("カレンダーに登録できませんでした。");
  });

  it("tools are unavailable (no fetch) when the proxy env is missing", async () => {
    delete process.env.HEDWIG_CAL_BASE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await loadTool("calendar_create").execute("call-3", {
      title: "x",
      start: "2026-07-01T14:00",
    });
    const outU = await loadTool("calendar_update").execute("call-3b", {
      date: "2026-07-10",
      title: "x",
      location: "y",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.content[0].text).toContain("利用できません");
    expect(outU.content[0].text).toContain("利用できません");
  });

  it("calendar_update posts to /events/update and relays every confirmed report verbatim (updated / not-found)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        updated: true,
        report: "「防衛省2次試験」（7月10日）に場所「市ヶ谷」を設定しました。",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = loadTool("calendar_update");
    const out = await tool.execute("call-5", {
      date: "2026-07-10",
      title: "防衛省2次試験",
      location: "市ヶ谷",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proxy.example/events/update");
    expect(url).not.toContain("tok-123");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toMatchObject({
      date: "2026-07-10",
      title: "防衛省2次試験",
      location: "市ヶ谷",
    });
    expect(out.content[0].text).toBe(
      "「防衛省2次試験」（7月10日）に場所「市ヶ谷」を設定しました。",
    );

    // Not-found is a confirmed outcome (ok:true + its own report), not a failure.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        updated: false,
        found: false,
        report: "「存在しない予定」（7月10日）の予定は見つかりませんでした。",
      }),
    }));
    const nf = await tool.execute("call-6", {
      date: "2026-07-10",
      title: "存在しない予定",
      location: "どこか",
    });
    expect(nf.content[0].text).toBe("「存在しない予定」（7月10日）の予定は見つかりませんでした。");
  });

  it("calendar_update reports an honest failure when the server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "upstream error" }) })),
    );
    const tool = loadTool("calendar_update");
    const out = await tool.execute("call-7", { date: "2026-07-10", title: "x", location: "y" });
    expect(out.content[0].text).toBe("カレンダーを更新できませんでした。");
  });
});
