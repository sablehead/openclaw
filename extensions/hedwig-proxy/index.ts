// Hedwig proxy plugin: real POST actions for calendar writes.
//
// The agent's only HTTP egress (web_fetch) is GET-only and exposes the full URL —
// and any token in it — to request logs and the session transcript. These tools run
// in the gateway, so the proxy token rides the Authorization header from env and
// never reaches the model or a transcript. All calendar logic (idempotency, event
// resolution, the JST confirmation sentence) stays owned by the hedwig-cal service;
// this only forwards the fields and relays the server's confirmed `report` verbatim.
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

const CalendarUpdateSchema = Type.Object({
  date: Type.String({ description: "Day of the existing event in JST, YYYY-MM-DD." }),
  title: Type.String({
    description: "Exact title of the existing event as it appears in the calendar.",
  }),
  location: Type.String({ description: "Place to set on that event." }),
});

// Shared POST → confirmed-`report` relay for both write tools. Honest failure:
// never invent success when the server didn't confirm it (no ok flag, an error
// body, a non-2xx status, or a timeout — hedwig-cal autostops, so a cold or
// unreachable proxy must surface as a failure, not a hung call).
async function postProxy(path: string, payload: Record<string, unknown>, failText: string) {
  const result = (body: string, details: unknown) => ({
    content: [{ type: "text" as const, text: body }],
    details,
  });
  const base = process.env.HEDWIG_CAL_BASE;
  const token = process.env.HEDWIG_CAL_TOKEN;
  if (!base || !token) {
    return result("カレンダー操作は利用できません（プロキシ未設定）。", { ok: false });
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || data.ok !== true) {
      return result(failText, data ?? { ok: false });
    }
    // The server owns the confirmed wording (created / duplicate / not-found /
    // ambiguous); relay it verbatim so the model never re-derives the outcome.
    const report = typeof data.report === "string" ? data.report : "結果を確認できませんでした。";
    return result(report, data);
  } catch {
    return result(failText, { ok: false });
  }
}

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
        return postProxy(
          "/events",
          params as Record<string, unknown>,
          "カレンダーに登録できませんでした。",
        );
      },
    });
    api.registerTool({
      name: "calendar_update",
      label: "Calendar Update",
      description:
        "Set the location of an EXISTING calendar event (location ask-back). The server resolves the event by exact title + day (JST) — never guess or pass an event id. Not-found and same-title-ambiguity come back as confirmed `report` sentences; relay the `report` verbatim and never infer success yourself.",
      parameters: CalendarUpdateSchema,
      async execute(_toolCallId, params) {
        return postProxy(
          "/events/update",
          params as Record<string, unknown>,
          "カレンダーを更新できませんでした。",
        );
      },
    });
  },
});
