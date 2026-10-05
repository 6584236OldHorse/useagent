export type DesktopBridge = {
  platform: "darwin" | "win32" | "linux";
  openExternal(url: string): void;
};

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const value = (window as Window & { useagentDesktop?: Partial<DesktopBridge> }).useagentDesktop;
  return value && ["darwin", "win32", "linux"].includes(value.platform ?? "")
    && typeof value.openExternal === "function" ? value as DesktopBridge : null;
}
