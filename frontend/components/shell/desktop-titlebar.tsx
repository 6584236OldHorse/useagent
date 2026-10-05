"use client";

import { useEffect, useState } from "react";
import { desktopBridge } from "@/lib/desktop-bridge";

/** Native window chrome only; a normal browser keeps its existing layout. */
export function DesktopTitlebar() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const desktop = desktopBridge();
    if (desktop?.platform !== "darwin") return;
    document.documentElement.style.setProperty("--desktop-titlebar-height", "36px");
    setVisible(true);
    return () => {
      document.documentElement.style.removeProperty("--desktop-titlebar-height");
    };
  }, []);
  return visible ? (
    <div aria-hidden className="h-9 shrink-0 bg-transparent [-webkit-app-region:drag]" />
  ) : null;
}
