import { z } from "zod";
import { Browser } from "./browser";
import { Result } from "./result";

const API = "https://api.nocaptchaai.com";
const POLL_INTERVAL_MS = 3_000;
const SOLVE_TIMEOUT_MS = 120_000;

export type CaptchaKind = "recaptcha-v2" | "recaptcha-enterprise" | "hcaptcha" | "turnstile";

export type DetectedCaptcha = { kind: CaptchaKind; sitekey: string };

const DetectedSchema = z
  .object({ kind: z.enum(["recaptcha-v2", "recaptcha-enterprise", "hcaptcha", "turnstile"]), sitekey: z.string().min(1) })
  .nullable();

/** Finds a captcha widget on the page and the site key it was rendered with. */
const DETECT_SCRIPT = `(() => {
  const frames = [...document.querySelectorAll("iframe")].map((f) => f.src || "");
  const attr = (selector) => document.querySelector(selector)?.getAttribute("data-sitekey") || null;
  const recaptchaFrame = frames.find((src) => src.includes("google.com/recaptcha") || src.includes("recaptcha.net/recaptcha"));
  if (recaptchaFrame) {
    const key = new URL(recaptchaFrame).searchParams.get("k") || attr(".g-recaptcha");
    if (key) return JSON.stringify({ kind: recaptchaFrame.includes("/enterprise") ? "recaptcha-enterprise" : "recaptcha-v2", sitekey: key });
  }
  const hcaptchaFrame = frames.find((src) => src.includes("hcaptcha.com"));
  if (hcaptchaFrame) {
    const key = new URLSearchParams(hcaptchaFrame.split("#")[1] || "").get("sitekey") || attr(".h-captcha") || attr("[data-hcaptcha-widget-id]");
    if (key) return JSON.stringify({ kind: "hcaptcha", sitekey: key });
  }
  const turnstileKey = attr(".cf-turnstile");
  if (turnstileKey) return JSON.stringify({ kind: "turnstile", sitekey: turnstileKey });
  return JSON.stringify(null);
})()`;

/** Puts a solved token where the page and its callback expect to find it. */
const injectScript = (kind: CaptchaKind, token: string) => `(() => {
  const token = ${JSON.stringify(token)};
  const fields = {
    "recaptcha-v2": 'textarea[name="g-recaptcha-response"]',
    "recaptcha-enterprise": 'textarea[name="g-recaptcha-response"]',
    hcaptcha: 'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]',
    turnstile: 'input[name="cf-turnstile-response"]'
  }[${JSON.stringify(kind)}];
  document.querySelectorAll(fields).forEach((el) => {
    el.value = token;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const callbacks = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    if (typeof node.callback === "function") callbacks.push(node.callback);
    Object.values(node).forEach((child) => walk(child, depth + 1));
  };
  walk(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients, 0);
  callbacks.forEach((callback) => callback(token));
  return JSON.stringify({ fields: document.querySelectorAll(fields).length, callbacks: callbacks.length });
})()`;

export type CaptchaSolver = {
  name: string;
  supports: (kind: CaptchaKind) => boolean;
  solve: (captcha: DetectedCaptcha, pageUrl: string) => Promise<Result<string>>;
};

/** Task types confirmed in the provider's docs. hCaptcha is left out until its type string is confirmed. */
const NOCAPTCHAAI_TASKS: Partial<Record<CaptchaKind, string>> = {
  "recaptcha-v2": "RecaptchaV2TaskProxyless",
  turnstile: "AntiTurnstileTask"
};

const TaskResponseSchema = z.object({
  errorId: z.number().default(0),
  errorDescription: z.string().optional(),
  taskId: z.string().optional(),
  solution: z.object({ gRecaptchaResponse: z.string().optional(), token: z.string().optional() }).optional()
});

const tokenOf = (response: z.infer<typeof TaskResponseSchema>) => response.solution?.gRecaptchaResponse ?? response.solution?.token ?? null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const post = async (path: string, body: unknown): Promise<Result<z.infer<typeof TaskResponseSchema>>> => {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) return Result.err(`nocaptchaai ${path} returned HTTP ${response.status}.`);
  const parsed = TaskResponseSchema.safeParse(await response.json());
  if (!parsed.success) return Result.err(`nocaptchaai ${path} returned an unexpected response shape.`);
  return parsed.data.errorId === 0 ? Result.ok(parsed.data) : Result.err(`nocaptchaai error: ${parsed.data.errorDescription ?? `errorId ${parsed.data.errorId}`}`);
};

const nocaptchaai = (clientKey: string): CaptchaSolver => ({
  name: "nocaptchaai",
  supports: (kind) => kind in NOCAPTCHAAI_TASKS,
  solve: async (captcha, pageUrl) => {
    const type = NOCAPTCHAAI_TASKS[captcha.kind];
    if (!type) return Result.err(`nocaptchaai has no confirmed task type for ${captcha.kind}.`);
    const created = await post("/createTask", { clientKey, task: { type, websiteURL: pageUrl, websiteKey: captcha.sitekey } });
    if (!created.ok) return created;
    const immediate = tokenOf(created.value);
    if (immediate) return Result.ok(immediate);
    if (!created.value.taskId) return Result.err("nocaptchaai accepted the task but returned no task id.");
    const deadline = Date.now() + SOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const result = await post("/getTaskResult", { clientKey, taskId: created.value.taskId });
      if (!result.ok) return result;
      const token = tokenOf(result.value);
      if (token) return Result.ok(token);
    }
    return Result.err("nocaptchaai did not return a token in time.");
  }
});

/** Off unless CAPTCHA_SOLVER=nocaptchaai and NOCAPTCHAAI_API_KEY are both set. */
const configuredSolver = (): CaptchaSolver | null => {
  const key = process.env.NOCAPTCHAAI_API_KEY;
  return process.env.CAPTCHA_SOLVER === "nocaptchaai" && key ? nocaptchaai(key) : null;
};

const detect = async (): Promise<Result<DetectedCaptcha | null>> => {
  const evaluated = await Browser.eval(DETECT_SCRIPT);
  if (!evaluated.ok) return evaluated;
  try {
    return Result.ok(DetectedSchema.parse(JSON.parse(evaluated.value)));
  } catch {
    return Result.err("Could not read the captcha widget from the page.");
  }
};

const inject = async (kind: CaptchaKind, token: string) => Browser.eval(injectScript(kind, token));

export const Captcha = { detect, inject, configuredSolver, nocaptchaai } as const;

export const CaptchaParsing = { injectScript, tokenOf, DETECT_SCRIPT, NOCAPTCHAAI_TASKS } as const;
