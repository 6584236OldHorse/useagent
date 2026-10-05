import {
  CodexAppServerAuthError,
  type CodexAppServerClient,
  type CodexAppServerLoginStartResult,
  type CodexChatGptLoginCompletion,
  type CodexChatGptStatus,
  type CodexRateLimits,
  type CodexRateLimitWindow,
} from "./codex-app-server-contracts";

export async function startCodexChatGptAccountLogin(
  appServer: CodexAppServerClient,
  loginMethod?: "chatgpt" | "device_code",
): Promise<CodexAppServerLoginStartResult> {
  const params = loginMethod === "device_code"
    ? { type: "chatgptDeviceCode" }
    : {
        type: "chatgpt",
        codexStreamlinedLogin: true,
        useHostedLoginSuccessPage: true,
      };
  const response = await appServer.request("account/login/start", params);
  return parseLoginStartResult(response);
}

export async function cancelCodexChatGptAppServerLogin(input: {
  appServer: CodexAppServerClient;
  loginId: string;
}): Promise<{ status: string }> {
  const response = await input.appServer.request(
    "account/login/cancel",
    { loginId: input.loginId },
  );
  if (
    !response ||
    typeof response !== "object" ||
    typeof (response as { status?: unknown }).status !== "string"
  ) {
    throw new CodexAppServerAuthError("app_server_rejected");
  }
  return { status: (response as { status: string }).status };
}

export async function readCodexChatGptAppServerStatus(
  appServer: CodexAppServerClient,
): Promise<CodexChatGptStatus> {
  const response = await appServer.request("account/read", { refreshToken: false });
  if (!response || typeof response !== "object") {
    throw new CodexAppServerAuthError("app_server_rejected");
  }
  const record = response as {
    account?: { type?: unknown; authMode?: unknown; email?: unknown; planType?: unknown } | null;
    requiresOpenaiAuth?: unknown;
  };
  const account = record.account && typeof record.account === "object"
    ? {
        authMode: typeof record.account.type === "string"
          ? record.account.type
          : typeof record.account.authMode === "string" ? record.account.authMode : null,
        email: typeof record.account.email === "string" ? record.account.email : null,
        planType: typeof record.account.planType === "string" ? record.account.planType : null,
      }
    : null;
  return {
    account,
    requiresOpenaiAuth: record.requiresOpenaiAuth === true,
  };
}

function rateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  if (typeof window.usedPercent !== "number") return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  };
}

/** The subscription's rolling usage windows, as the app-server reports them. */
export async function readCodexRateLimits(appServer: CodexAppServerClient): Promise<CodexRateLimits> {
  const response = await appServer.request("account/rateLimits/read", undefined);
  if (!response || typeof response !== "object") {
    throw new CodexAppServerAuthError("app_server_rejected");
  }
  const limits = (response as { rateLimits?: unknown }).rateLimits;
  const record = limits && typeof limits === "object"
    ? limits as { planType?: unknown; primary?: unknown; secondary?: unknown }
    : {};
  return {
    planType: typeof record.planType === "string" ? record.planType : null,
    primary: rateLimitWindow(record.primary),
    secondary: rateLimitWindow(record.secondary),
  };
}

export function completeCodexChatGptAppServerLogin(notification: {
  loginId: string | null;
  success: boolean;
  error: string | null;
}): CodexChatGptLoginCompletion {
  return {
    status: "completed",
    loginId: notification.loginId,
    success: notification.success,
    error: notification.error,
  };
}

function parseLoginStartResult(response: unknown): CodexAppServerLoginStartResult {
  if (!response || typeof response !== "object") {
    throw new CodexAppServerAuthError("app_server_rejected");
  }
  const record = response as {
    type?: unknown;
    loginId?: unknown;
    authUrl?: unknown;
    verificationUrl?: unknown;
    userCode?: unknown;
  };
  if (
    record.type === "chatgpt" &&
    typeof record.loginId === "string" &&
    typeof record.authUrl === "string"
  ) {
    return {
      type: "chatgpt",
      loginId: record.loginId,
      authUrl: record.authUrl,
    };
  }
  if (
    record.type === "chatgptDeviceCode" &&
    typeof record.loginId === "string" &&
    typeof record.verificationUrl === "string" &&
    typeof record.userCode === "string"
  ) {
    return {
      type: "chatgptDeviceCode",
      loginId: record.loginId,
      verificationUrl: record.verificationUrl,
      userCode: record.userCode,
    };
  }
  throw new CodexAppServerAuthError("app_server_rejected");
}
