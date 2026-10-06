import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Result } from "./result";

const TOKEN_PATH = "data/gmail-token.json";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Read mail to catch verification codes and replies; compose to create drafts and send approved ones. */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose"
];
const CODE_POLL_INTERVAL_MS = 4_000;
const CLOCK_SKEW_MS = 5_000;

const TokenSchema = z.object({ refreshToken: z.string(), accessToken: z.string(), expiresAt: z.number() });
type Token = z.infer<typeof TokenSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional()
});

const MessageListSchema = z.object({ messages: z.array(z.object({ id: z.string() })).default([]) });

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
const PartSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(PartSchema).optional()
  })
);

const MessageSchema = z.object({
  internalDate: z.string(),
  payload: PartSchema,
  snippet: z.string().default("")
});

const DraftSchema = z.object({ id: z.string() });

const pendingStates = new Set<string>();

const port = () => Number(process.env.OAUTH_PORT ?? 3000);
const redirectUri = () => process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${port()}/oauth/google/callback`;

const credentials = (): Result<{ id: string; secret: string }> => {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return id && secret
    ? Result.ok({ id, secret })
    : Result.err("Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (a Google Cloud OAuth client of type Web application), then restart.");
};

const readToken = async (): Promise<Token | null> => {
  try {
    return TokenSchema.parse(JSON.parse(await readFile(TOKEN_PATH, "utf8")));
  } catch {
    return null;
  }
};

const writeToken = async (token: Token) => {
  await mkdir("data", { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token), { encoding: "utf8", mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600);
};

const requestToken = async (params: Record<string, string>): Promise<Result<z.infer<typeof TokenResponseSchema>>> => {
  const creds = credentials();
  if (!creds.ok) return creds;
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.value.id, client_secret: creds.value.secret, ...params })
  });
  if (!response.ok) return Result.err(`Google rejected the token request (${response.status}). If this is a refresh, the grant may have expired; reconnect Gmail.`);
  return Result.ok(TokenResponseSchema.parse(await response.json()));
};

const accessToken = async (): Promise<Result<string>> => {
  const token = await readToken();
  if (!token) return Result.err("Gmail is not connected. Call connect_gmail and have the user open the link.");
  if (token.expiresAt > Date.now() + CLOCK_SKEW_MS) return Result.ok(token.accessToken);
  const refreshed = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken });
  if (!refreshed.ok) return refreshed;
  await writeToken({
    refreshToken: refreshed.value.refresh_token ?? token.refreshToken,
    accessToken: refreshed.value.access_token,
    expiresAt: Date.now() + refreshed.value.expires_in * 1000
  });
  return Result.ok(refreshed.value.access_token);
};

const api = async (path: string, init?: RequestInit): Promise<Result<unknown>> => {
  const token = await accessToken();
  if (!token.ok) return token;
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" }
  });
  if (!response.ok) return Result.err(`Gmail API ${response.status} on ${path.split("?")[0]}.`);
  return Result.ok(response.status === 204 ? null : await response.json());
};

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const bodyText = (part: Part): string => {
  const own = part.body?.data ? decode(part.body.data) : "";
  const text = part.mimeType === "text/html" ? own.replace(/<[^>]+>/g, " ") : own;
  return [text, ...(part.parts ?? []).map(bodyText)].join("\n");
};

/** Finds a short alphanumeric verification code in an email. */
const extractCode = (text: string): string | null => {
  // Plain words ("editor", "ALONGS" in a newsletter) also fit the shape, so a code must contain a digit.
  const looksLikeCode = (candidate: string) => /\d/.test(candidate);
  const lines = text.split("\n");
  // Codes sit on the line that mentions "code" or on the line right after it.
  const nearLabel = lines.flatMap((line, index) => (/\b(?:code|passcode)\b/i.test(line) ? [line, lines[index + 1] ?? ""] : []));
  const alone = lines.filter((line) => /^\s*[A-Za-z0-9]{8}\s*$/.test(line));
  const tokens = [...nearLabel, ...alone].flatMap((line) => line.match(/\b[A-Za-z0-9]{6,8}\b/g) ?? []);
  return tokens.find(looksLikeCode) ?? null;
};

const rejectHeaderInjection = (value: string) => !/[\r\n]/.test(value);

const encodeSubject = (subject: string) => (/^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`);

const rawMessage = (to: string, subject: string, body: string) =>
  Buffer.from(
    [`To: ${to}`, `Subject: ${encodeSubject(subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", body].join("\r\n")
  ).toString("base64url");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const Gmail = {
  isConnected: async () => (await readToken()) !== null,

  authUrl: (): Result<string> => {
    const creds = credentials();
    if (!creds.ok) return creds;
    const state = crypto.randomUUID();
    pendingStates.add(state);
    const params = new URLSearchParams({
      client_id: creds.value.id,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state
    });
    return Result.ok(`${AUTH_ENDPOINT}?${params}`);
  },

  /** Local server that receives Google's redirect after the user approves access. */
  serve: () =>
    Bun.serve({
      port: port(),
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/oauth/google/callback") return new Response("Not found", { status: 404 });
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code || !pendingStates.delete(state)) return new Response("Invalid or expired link. Ask the agent for a new one.", { status: 400 });
        const exchanged = await requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
        if (!exchanged.ok) return new Response(exchanged.error, { status: 502 });
        if (!exchanged.value.refresh_token) return new Response("Google did not return a refresh token. Remove the app from your Google account permissions and connect again.", { status: 502 });
        await writeToken({
          refreshToken: exchanged.value.refresh_token,
          accessToken: exchanged.value.access_token,
          expiresAt: Date.now() + exchanged.value.expires_in * 1000
        });
        return new Response("Gmail connected. You can close this tab and go back to the chat.");
      }
    }),

  /** Polls for a verification email that arrived after `since` and returns only the code, never the email. */
  waitForCode: async (since: Date, timeoutMs: number): Promise<Result<string>> => {
    const deadline = Date.now() + timeoutMs;
    const afterSeconds = Math.floor(since.getTime() / 1000) - 5;
    while (Date.now() < deadline) {
      const listed = await api(`/messages?maxResults=5&q=${encodeURIComponent(`after:${afterSeconds} subject:(code OR verification OR passcode)`)}`);
      if (!listed.ok) return listed;
      for (const { id } of MessageListSchema.parse(listed.value).messages) {
        const message = await api(`/messages/${id}?format=full`);
        if (!message.ok) continue;
        const parsed = MessageSchema.parse(message.value);
        if (Number(parsed.internalDate) < since.getTime() - CLOCK_SKEW_MS) continue;
        const code = extractCode(`${parsed.snippet}\n${bodyText(parsed.payload)}`);
        if (code) return Result.ok(code);
      }
      await sleep(CODE_POLL_INTERVAL_MS);
    }
    return Result.err("No verification email arrived in time. Ask the user to paste the code from their inbox.");
  },

  createDraft: async (to: string, subject: string, body: string): Promise<Result<string>> => {
    if (!rejectHeaderInjection(to) || !rejectHeaderInjection(subject)) return Result.err("Recipient and subject must be single lines.");
    const created = await api("/drafts", { method: "POST", body: JSON.stringify({ message: { raw: rawMessage(to, subject, body) } }) });
    return created.ok ? Result.ok(DraftSchema.parse(created.value).id) : created;
  },

  /** Removes a draft from Gmail. A draft that is already gone counts as deleted. */
  deleteDraft: async (draftId: string): Promise<Result<string>> => {
    const deleted = await api(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    return deleted.ok || deleted.error.includes("404") ? Result.ok(draftId) : deleted;
  },

  sendDraft: async (draftId: string): Promise<Result<string>> => {
    const sent = await api("/drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
    return sent.ok ? Result.ok(draftId) : sent;
  }
} as const;

export const GmailParsing = { extractCode } as const;
