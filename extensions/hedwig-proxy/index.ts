// Hedwig proxy plugin: a real POST action for calendar writes.
//
// The agent's only HTTP egress (web_fetch) is GET-only and exposes the full URL —
// and any token in it — to request logs and the session transcript. This tool runs
// in the gateway, so the proxy token rides the Authorization header from env and
// never reaches the model or a transcript. All calendar logic (idempotency, the
// JST confirmation sentence) stays owned by the hedwig-cal service; this only
// forwards the fields and relays the server's confirmed `report` verbatim.
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

const CalendarCreateSchema = Type.Object({
  title: Type.String({ description: "Event title (concise; who/what, not the place)." }),
  start: Type.String({
    description: "Start in JST. Timed: YYYY-MM-DDTHH:MM. All-day: YYYY-MM-DD.",
  }),
  end: Type.Optional(Type.String({ description: "End (same format). Defaults to start + 1h." })),
  colorId: Type.Optional(Type.String({ description: "Google colorId 1-11 (event nature)." })),
  location: Type.Optional(Type.String({ description: "Place; keep it out of the title." })),
  desc: Type.Optional(Type.String({ description: "Notes as short 'key: value' tag lines." })),
  allDay: Type.Optional(Type.Boolean({ description: "True for a date-only all-day event." })),
});

export default definePluginEntry({
  id: "hedwig-proxy",
  name: "Hedwig Proxy",
  description: "Authenticated write actions against the Hedwig proxy service (calendar).",
  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "calendar_create",
      label: "Calendar Create",
      description:
        "Create a Google Calendar event. Idempotent: a same title+start re-send returns the existing event, never a double-booking. The result carries a server-confirmed `report` sentence — relay it verbatim and never infer success yourself.",
      parameters: CalendarCreateSchema,
      async execute(_toolCallId, params) {
        const result = (body: string, details: unknown) => ({
          content: [{ type: "text" as const, text: body }],
          details,
        });
        const base = process.env.HEDWIG_CAL_BASE;
        const token = process.env.HEDWIG_CAL_TOKEN;
        if (!base || !token) {
          return result("カレンダー登録は利用できません（プロキシ未設定）。", { ok: false });
        }
        const payload = params as Record<string, unknown>;
        try {
          const res = await fetch(`${base.replace(/\/+$/, "")}/events`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
            // Bound the wait: hedwig-cal autostops, so a cold or unreachable proxy
            // must surface as an honest failure, not a hung tool call. Cold wake is
            // a few seconds; 30s leaves ample headroom.
            signal: AbortSignal.timeout(30000),
          });
          const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          // Honest failure: never invent success when the server didn't confirm it
          // (no ok flag, an error body, or a non-2xx status).
          if (!res.ok || !data || data.ok !== true) {
            return result("カレンダーに登録できませんでした。", data ?? { ok: false });
          }
          // The server owns the confirmed wording (created vs already-registered);
          // relay it verbatim so the model never re-derives or guesses the outcome.
          const report =
            typeof data.report === "string" ? data.report : "登録結果を確認できませんでした。";
          return result(report, data);
        } catch {
          return result("カレンダーに登録できませんでした。", { ok: false });
        }
      },
    });
  },
});
