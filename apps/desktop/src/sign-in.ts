import { parseCookies } from "better-auth/cookies";
import type { BrowserWindow } from "electron";

export type DesktopAuthClient = {
  requestAuth(): Promise<void>;
  authenticate(input: { token: string }): Promise<{ error: { message?: string } | null }>;
  getCookie(): string;
  getSession(): Promise<{ data: { session: { activeOrganizationId?: string | null } } | null; error: unknown }>;
  organization: {
    list(): Promise<{ data: Array<{ id: string; name: string }> | null; error: unknown }>;
    setActive(input: { organizationId: string }): Promise<{ error: unknown }>;
  };
};

export type DesktopOrganization = { id: string; name: string };

function callbackToken(value: string): string {
  if (value.length > 16_384) throw new Error("Invalid desktop sign-in callback.");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Invalid desktop sign-in callback."); }
  if (url.protocol !== "useagent:" || url.hostname !== "auth" || url.pathname !== "/callback"
    || url.port || url.search || url.username || url.password || !/^#token=[A-Za-z0-9_-]+$/.test(url.hash)) {
    throw new Error("Invalid desktop sign-in callback.");
  }
  return url.hash.slice(7);
}

/** Better Auth owns PKCE and the one-use exchange; only its session cookies enter the app partition. */
export function createDesktopSignIn(
  plane: URL,
  window: BrowserWindow,
  client: DesktopAuthClient,
  chooseOrganization: (organizations: readonly DesktopOrganization[]) => Promise<string | undefined>,
) {
  const restore = async (): Promise<boolean> => {
    const cookies = [...parseCookies(client.getCookie())]
      .filter(([name]) => /^(?:__Secure-|__Host-)?better-auth\.(?:session_token|session_data)$/.test(name));
    if (!cookies.some(([name]) => name.endsWith(".session_token"))) return false;
    await Promise.all(cookies.map(([name, cookie]) => window.webContents.session.cookies.set({
      url: plane.href, name, value: cookie, path: "/", httpOnly: true,
      secure: plane.protocol === "https:", sameSite: "lax",
    })));
    return true;
  };
  const ensureActiveOrganization = async (): Promise<void> => {
    const [session, organizations] = await Promise.all([client.getSession(), client.organization.list()]);
    if (session.error || !session.data || organizations.error || !Array.isArray(organizations.data)) {
      throw new Error("Desktop workspace could not be verified.");
    }
    const available = organizations.data.filter(organization =>
      typeof organization.id === "string" && organization.id.length > 0
      && typeof organization.name === "string" && organization.name.length > 0);
    const active = session.data.session.activeOrganizationId;
    if (active) {
      if (!available.some(organization => organization.id === active)) throw new Error("Desktop workspace could not be verified.");
      return;
    }
    const organizationId = available.length === 1 ? available[0]!.id
      : available.length > 1 ? await chooseOrganization(available) : undefined;
    if (!organizationId || !available.some(organization => organization.id === organizationId)) {
      throw new Error("Desktop workspace was not selected.");
    }
    if ((await client.organization.setActive({ organizationId })).error) {
      throw new Error("Desktop workspace could not be selected.");
    }
  };
  return {
    begin: () => client.requestAuth(),
    restore,
    async complete(value: string): Promise<void> {
      const result = await client.authenticate({ token: callbackToken(value) });
      if (result.error) throw new Error("Desktop sign-in could not be verified. Try again.");
      await ensureActiveOrganization();
      if (!await restore()) throw new Error("Invalid sign-in response.");
      await window.loadURL(plane.href);
      window.show();
      window.focus();
    },
  };
}
