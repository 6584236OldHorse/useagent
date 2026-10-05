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
  // An overlay, not a spacer: the surface below (shell frame, sign-in screen)
  // pads itself by --desktop-titlebar-height and paints under the traffic
  // lights, so the strip never shows the body colour as a separate band.
  return visible ? (
    <div aria-hidden className="fixed inset-x-0 top-0 z-50 h-9 bg-transparent [-webkit-app-region:drag]" />
  ) : null;
}
