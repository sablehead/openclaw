// Phase A: frictionless active brief feedback (measurement only).
//
// The brief eval loop stalled because writing a reaction is effort: 42 briefs
// drew 0 native Telegram reactions. This wires one-tap labelled buttons onto
// brief deliveries and persists each tap to SQLite — with the agent never woken,
// so capturing a vote costs zero model tokens. Two halves:
//
//   1. attach  — a `reply_payload_sending` hook appends a fixed buttons block to
//      brief (cron) Telegram finals. The LLM writes prose; this hook owns the
//      buttons, so the model never has to emit exact callback tokens. (Alert
//      messages sent outside the gateway carry their own buttons; the capture
//      half below records taps on either surface, since the bot is the same.)
//   2. capture — a registered interactive handler for the `hedwigfb` namespace
//      runs on tap, before the generic callback path that would wake the agent.
//      It records the vote and clears the keyboard as a visible ack.
//
// Phase A only measures tap rate; weekly aggregation and any threshold
// auto-proposal are deliberately out of scope.
import type {
  MessagePresentation,
  MessagePresentationButtonsBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

/** Callback namespace; the first `:`-segment of every feedback button value. */
const FEEDBACK_NAMESPACE = "hedwigfb";
/** Plugin-KV namespace (shared state SQLite) holding one row per voted delivery. */
const FEEDBACK_STORE_NAMESPACE = "hedwig-feedback";

type FeedbackValue = "up" | "dn" | "more" | "less";

const FEEDBACK_BUTTONS: ReadonlyArray<{ label: string; code: FeedbackValue }> = [
  { label: "👍", code: "up" },
  { label: "👎", code: "dn" },
  { label: "もっと", code: "more" },
  { label: "いらない", code: "less" },
];

const FEEDBACK_VALUES = new Set<FeedbackValue>(FEEDBACK_BUTTONS.map((b) => b.code));

/** One persisted vote, keyed by `${surface}:${messageId}`. */
type FeedbackRecord = {
  surface: string;
  value: FeedbackValue;
  chatId: string;
  messageId: number;
  firstTapTs: number;
  lastTapTs: number;
  /** Re-taps (mind-changes); ~always 1 since a tap clears the keyboard. */
  tapCount: number;
};

/**
 * Stable, non-PII surface tag for a brief delivery. Cron session keys are
 * `cron:<jobId>` (jobId is a UUID — see isolated-agent run.ts), so the first 8
 * id chars identify which brief without hardcoding a job UUID in product code;
 * the KV record is mapped back to morning/evening offline. Returns null for any
 * non-cron session, which is how non-brief replies opt out of buttons.
 */
export function resolveBriefSurfaceTag(sessionKey: string | undefined | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = /cron:([0-9a-zA-Z-]+)/.exec(sessionKey);
  if (!match) {
    return null;
  }
  const tag = match[1].replace(/-/g, "").slice(0, 8).toLowerCase();
  return tag.length >= 4 ? tag : null;
}

function buildFeedbackButtonsBlock(surface: string): MessagePresentationButtonsBlock {
  return {
    type: "buttons",
    buttons: FEEDBACK_BUTTONS.map((b) => ({
      label: b.label,
      // type:"callback" → the channel encodes an opaque callback value, which the
      // `hedwigfb` interactive handler matches. A plain `value` would skip opaque
      // encoding and never route to the handler.
      action: { type: "callback", value: `${FEEDBACK_NAMESPACE}:${surface}:${b.code}` },
    })),
  };
}

/** True when this payload already carries our feedback buttons (re-dispatch guard). */
export function hasFeedbackButtons(payload: Pick<ReplyPayload, "presentation">): boolean {
  const blocks = payload.presentation?.blocks ?? [];
  return blocks.some(
    (block) =>
      block.type === "buttons" &&
      block.buttons.some(
        (b) => b.action?.type === "callback" && b.action.value.startsWith(`${FEEDBACK_NAMESPACE}:`),
      ),
  );
}

/** Returns a copy of `payload` with the feedback buttons appended, text untouched. */
export function attachFeedbackButtons<T extends Pick<ReplyPayload, "presentation">>(
  payload: T,
  surface: string,
): T {
  const block = buildFeedbackButtonsBlock(surface);
  const existing = payload.presentation;
  const presentation: MessagePresentation = existing
    ? { ...existing, blocks: [...existing.blocks, block] }
    : { blocks: [block] };
  return { ...payload, presentation };
}

/** Splits a callback payload `<surface>:<value>` and validates the vote code. */
export function parseFeedbackPayload(
  payload: string | undefined,
): { surface: string; value: FeedbackValue } | null {
  if (!payload) {
    return null;
  }
  const sep = payload.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  const surface = payload.slice(0, sep);
  const value = payload.slice(sep + 1);
  if (!FEEDBACK_VALUES.has(value as FeedbackValue)) {
    return null;
  }
  return { surface, value: value as FeedbackValue };
}

async function recordFeedback(
  store: PluginStateKeyedStore<FeedbackRecord>,
  params: { surface: string; value: FeedbackValue; chatId: string; messageId: number; now: number },
): Promise<void> {
  const key = `${params.surface}:${params.messageId}`;
  // Non-atomic read-modify-write is fine here: one owner, per-tap callback dedupe
  // upstream, and the keyboard is cleared on first tap — concurrent taps on the
  // same delivery don't realistically race.
  const existing = await store.lookup(key);
  const next: FeedbackRecord = existing
    ? { ...existing, value: params.value, lastTapTs: params.now, tapCount: existing.tapCount + 1 }
    : {
        surface: params.surface,
        value: params.value,
        chatId: params.chatId,
        messageId: params.messageId,
        firstTapTs: params.now,
        lastTapTs: params.now,
        tapCount: 1,
      };
  await store.register(key, next);
}

/** Minimal shape of the telegram interactive-handler context we depend on. */
type FeedbackCallbackContext = {
  auth?: { isAuthorizedSender?: boolean };
  callback: { payload: string; messageId: number; chatId: string };
  respond: { clearButtons: () => Promise<void> };
};

/** Wires the attach hook + capture handler. Call once from the plugin register(). */
export function registerHedwigFeedback(api: OpenClawPluginApi): void {
  const store = api.runtime.state.openKeyedStore<FeedbackRecord>({
    namespace: FEEDBACK_STORE_NAMESPACE,
    maxEntries: 5_000,
  });
  // DIAG (temporary): confirm api.on actually registers this hook at startup.
  console.error("[hedwigfb-diag] registerHedwigFeedback: wiring hook + interactive handler");

  // Attach: only brief (cron) Telegram finals. `final` is the single delivered
  // answer; the channel places reply_markup on the last text chunk on its own.
  api.on("reply_payload_sending", (event) => {
    const surface =
      event.channel === "telegram" && event.kind === "final"
        ? resolveBriefSurfaceTag(event.sessionKey)
        : null;
    // DIAG (temporary): trace firing + gating to locate why brief buttons don't render.
    console.error(
      `[hedwigfb-diag] hook fired ${JSON.stringify({
        channel: event.channel,
        kind: event.kind,
        sessionKey: event.sessionKey,
        surface,
        alreadyButtoned: hasFeedbackButtons(event.payload),
      })}`,
    );
    if (event.channel !== "telegram" || event.kind !== "final") {
      return {};
    }
    if (!surface || hasFeedbackButtons(event.payload)) {
      return {};
    }
    console.error(`[hedwigfb-diag] attaching buttons surface=${surface}`);
    return { payload: attachFeedbackButtons(event.payload, surface) };
  });

  // Capture: runs before the agent-wake callback path, so a vote costs no tokens.
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: FEEDBACK_NAMESPACE,
    handler: async (raw) => {
      const ctx = raw as FeedbackCallbackContext;
      // DIAG (temporary): confirm taps reach the handler.
      console.error(
        `[hedwigfb-diag] interactive handler fired payload=${ctx.callback?.payload} authorized=${ctx.auth?.isAuthorizedSender}`,
      );
      // Claim the callback (it's our namespace) even when we drop it, so the
      // generic path never also fires for these taps.
      if (!ctx.auth?.isAuthorizedSender) {
        return { handled: true };
      }
      const parsed = parseFeedbackPayload(ctx.callback.payload);
      if (!parsed) {
        return { handled: true };
      }
      await recordFeedback(store, {
        surface: parsed.surface,
        value: parsed.value,
        chatId: ctx.callback.chatId,
        messageId: ctx.callback.messageId,
        now: Date.now(),
      });
      // Visible ack: drop the keyboard so the owner sees the tap landed and can't
      // double-vote. Phase A wants one decisive tap per delivery.
      try {
        await ctx.respond.clearButtons();
      } catch {
        // A failed edit (message too old, already cleared) must not lose the vote.
      }
      return { handled: true };
    },
  });
}
