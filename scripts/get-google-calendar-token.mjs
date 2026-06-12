#!/usr/bin/env node
/**
 * One-time script to obtain a Google Calendar OAuth2 refresh token.
 *
 * Prerequisites:
 *   1. Google Cloud Console → APIs & Services → Enable "Google Calendar API"
 *   2. APIs & Services → Credentials → Create OAuth 2.0 Client ID
 *      - Application type: Desktop app
 *      - Download the JSON and note client_id and client_secret
 *
 * Usage:
 *   node scripts/get-google-calendar-token.mjs <client_id> <client_secret>
 *
 * Then copy the printed refresh_token and run:
 *   fly secrets set \
 *     GOOGLE_CALENDAR_CLIENT_ID=<client_id> \
 *     GOOGLE_CALENDAR_CLIENT_SECRET=<client_secret> \
 *     GOOGLE_CALENDAR_REFRESH_TOKEN=<refresh_token> \
 *     -a sableshedwig
 */

import { exec } from "child_process";
import http from "http";
import { URL } from "url";

const [, , clientId, clientSecret] = process.argv;
if (!clientId || !clientSecret) {
  console.error("Usage: node get-google-calendar-token.mjs <client_id> <client_secret>");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:9876/callback";
// calendar.events grants read AND write of events (create/edit), but not calendar
// management/sharing — least privilege for Hedwig's /events read + /events/create.
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log("\nOpening browser for Google OAuth consent...");
console.log("If it doesn't open automatically, visit:\n");
console.log(authUrl + "\n");

exec(`open "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:9876");
  if (url.pathname !== "/callback") {
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.end(`<h1>Error: ${error}</h1>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end("<h1>No code received</h1>");
    server.close();
    process.exit(1);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token in response:", JSON.stringify(tokens, null, 2));
    res.end(
      "<h1>Error: no refresh_token. Try revoking access at myaccount.google.com/permissions and re-running.</h1>",
    );
    server.close();
    process.exit(1);
  }

  console.log("\n✓ Success! Run the following to store the credentials:\n");
  console.log(
    `fly secrets set \\\n` +
      `  GOOGLE_CALENDAR_CLIENT_ID="${clientId}" \\\n` +
      `  GOOGLE_CALENDAR_CLIENT_SECRET="${clientSecret}" \\\n` +
      `  GOOGLE_CALENDAR_REFRESH_TOKEN="${tokens.refresh_token}" \\\n` +
      `  -a sableshedwig\n`,
  );

  res.end("<h1>✓ Done! Check your terminal for the next step.</h1>");
  server.close();
});

server.listen(9876, () => {
  console.log("Waiting for Google to redirect to localhost:9876...\n");
});
