import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it, vi } from "vitest";
import {
  attachFeedbackButtons,
  hasFeedbackButtons,
  parseFeedbackPayload,
  registerHedwigFeedback,
  resolveBriefSurfaceTag,
} from "./feedback.js";

const MORNING_BRIEF_SESSION = "main|cron:b0f26c87-d537-44cb-943f-ca3575c14d89";

type HookHandler = (event: Record<string, unknown>) => unknown;
type InteractiveHandler = (ctx: unknown) => Promise<{ handled?: boolean } | void>;

function makeHarness() {
  const store = new Map<string, unknown>();
  const keyedStore = {
    register: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    lookup: vi.fn(async (key: string) => store.get(key)),
  };
  let hook: HookHandler | undefined;
  let interactive: InteractiveHandler | undefined;
  const api = {
    runtime: { state: { openKeyedStore: () => keyedStore } },
    on: (name: string, handler: HookHandler) => {
      if (name === "reply_payload_sending") {
        hook = handler;
      }
    },
    registerInteractiveHandler: (reg: { handler: InteractiveHandler }) => {
      interactive = reg.handler;
    },
  } as unknown as OpenClawPluginApi;
  registerHedwigFeedback(api);
  if (!hook || !interactive) {
    throw new Error("feedback hook/handler not registered");
  }
  return { store, keyedStore, hook, interactive };
}

describe("resolveBriefSurfaceTag", () => {
  it("derives an 8-char tag from a cron session key", () => {
    expect(resolveBriefSurfaceTag(MORNING_BRIEF_SESSION)).toBe("b0f26c87");
  });
  it("returns null for non-cron sessions", () => {
    expect(resolveBriefSurfaceTag("main|telegram:dm:123")).toBeNull();
    expect(resolveBriefSurfaceTag(undefined)).toBeNull();
  });
});

describe("parseFeedbackPayload", () => {
  it("splits surface:value and validates the vote code", () => {
    expect(parseFeedbackPayload("b0f26c87:up")).toEqual({ surface: "b0f26c87", value: "up" });
    expect(parseFeedbackPayload("b0f26c87:more")).toEqual({ surface: "b0f26c87", value: "more" });
  });
  it("rejects unknown codes and malformed payloads", () => {
    expect(parseFeedbackPayload("b0f26c87:yes")).toBeNull();
    expect(parseFeedbackPayload("nope")).toBeNull();
    expect(parseFeedbackPayload(undefined)).toBeNull();
  });
});

describe("attachFeedbackButtons", () => {
  it("appends 4 callback buttons and preserves existing text/presentation", () => {
    const payload: ReplyPayload = { text: "brief body" };
    const out = attachFeedbackButtons(payload, "b0f26c87");
    expect(out.text).toBe("brief body");
    const block = out.presentation?.blocks[0];
    expect(block?.type).toBe("buttons");
    expect(block?.type === "buttons" && block.buttons.map((b) => b.action)).toEqual([
      { type: "callback", value: "hedwigfb:b0f26c87:up" },
      { type: "callback", value: "hedwigfb:b0f26c87:dn" },
      { type: "callback", value: "hedwigfb:b0f26c87:more" },
      { type: "callback", value: "hedwigfb:b0f26c87:less" },
    ]);
    expect(hasFeedbackButtons(out)).toBe(true);
  });
});

describe("attach hook gating", () => {
  it("attaches buttons to a telegram cron final", () => {
    const { hook } = makeHarness();
    const result = hook({
      channel: "telegram",
      kind: "final",
      sessionKey: MORNING_BRIEF_SESSION,
      payload: { text: "今日の予定…" },
    }) as { payload?: { presentation?: unknown } } | undefined;
    expect(result?.payload).toBeDefined();
    expect(hasFeedbackButtons(result!.payload as never)).toBe(true);
  });

  it("skips non-final, non-telegram, non-cron, and already-buttoned payloads", () => {
    const { hook } = makeHarness();
    // Skipped cases return an empty result (no payload override), not a mutation.
    const noPayload = (event: Record<string, unknown>) =>
      (hook(event) as { payload?: unknown }).payload;
    expect(
      noPayload({
        channel: "telegram",
        kind: "tool",
        sessionKey: MORNING_BRIEF_SESSION,
        payload: {},
      }),
    ).toBeUndefined();
    expect(
      noPayload({
        channel: "slack",
        kind: "final",
        sessionKey: MORNING_BRIEF_SESSION,
        payload: {},
      }),
    ).toBeUndefined();
    expect(
      noPayload({
        channel: "telegram",
        kind: "final",
        sessionKey: "main|telegram:dm:1",
        payload: {},
      }),
    ).toBeUndefined();
    const buttoned = attachFeedbackButtons({ text: "x" } as ReplyPayload, "b0f26c87");
    expect(
      noPayload({
        channel: "telegram",
        kind: "final",
        sessionKey: MORNING_BRIEF_SESSION,
        payload: buttoned,
      }),
    ).toBeUndefined();
  });
});

describe("capture handler (zero-LLM)", () => {
  function callbackCtx(overrides?: Partial<{ payload: string; authorized: boolean }>) {
    const clearButtons = vi.fn(async () => {});
    const ctx = {
      auth: { isAuthorizedSender: overrides?.authorized ?? true },
      callback: {
        payload: overrides?.payload ?? "b0f26c87:up",
        messageId: 42,
        chatId: "8709180805",
      },
      respond: { clearButtons },
    };
    return { ctx, clearButtons };
  }

  it("records an authorized vote and clears the keyboard", async () => {
    const { interactive, store } = makeHarness();
    const { ctx, clearButtons } = callbackCtx();
    const res = await interactive(ctx);
    expect(res).toEqual({ handled: true });
    expect(clearButtons).toHaveBeenCalledOnce();
    expect(store.get("b0f26c87:42")).toMatchObject({
      surface: "b0f26c87",
      value: "up",
      chatId: "8709180805",
      messageId: 42,
      tapCount: 1,
    });
  });

  it("bumps tapCount and keeps firstTapTs on a re-vote", async () => {
    const { interactive, store } = makeHarness();
    await interactive(callbackCtx({ payload: "b0f26c87:up" }).ctx);
    const first = store.get("b0f26c87:42") as { firstTapTs: number };
    await interactive(callbackCtx({ payload: "b0f26c87:dn" }).ctx);
    const second = store.get("b0f26c87:42") as {
      value: string;
      tapCount: number;
      firstTapTs: number;
    };
    expect(second).toMatchObject({ value: "dn", tapCount: 2 });
    expect(second.firstTapTs).toBe(first.firstTapTs);
  });

  it("claims but drops unauthorized taps and invalid payloads (no record)", async () => {
    const { interactive, store } = makeHarness();
    expect(await interactive(callbackCtx({ authorized: false }).ctx)).toEqual({ handled: true });
    expect(await interactive(callbackCtx({ payload: "b0f26c87:yes" }).ctx)).toEqual({
      handled: true,
    });
    expect(store.size).toBe(0);
  });
});
