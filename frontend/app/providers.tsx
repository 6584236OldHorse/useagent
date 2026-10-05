'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { ThemeProvider } from 'next-themes';

import { SubagentPane } from '@/components/chat/subagent-pane';
import { DesktopTitlebar } from '@/components/shell/desktop-titlebar';
import { IdentitySessionSync } from '@/lib/auth';
import { legacyAuthEnabled } from '@/lib/auth-mode';

/**
 * Client-side provider stack. Kept as a leaf so the root layout stays a
 * server component. `next-themes` drives the theme class (`dark` / `aura` /
 * `harbor` / `phosphor` / `slate` / `sakura-night` / `light` / `sakura` /
 * `phosphor-light`) on <html>.
 *
 * `SubagentPane` is the single global instance of the subagent viewing pane -
 * a portal-based slide-over any surface can open via `openSubagentPane(runId)`.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const app = (
    <ThemeProvider
      attribute='class'
      defaultTheme='dark'
      enableSystem={false}
      themes={[
        'light',
        'dark',
        'dusk',
        'aura',
        'harbor',
        'phosphor',
        'phosphor-light',
        'sakura',
        'sakura-night',
        'slate',
      ]}
    >
      <DesktopTitlebar />
      {children}
      <SubagentPane />
    </ThemeProvider>
  );
  return legacyAuthEnabled ? (
    app
  ) : (
    <ClerkProvider signInUrl='/login' signUpUrl='/signup'>
      <IdentitySessionSync />
      {app}
    </ClerkProvider>
  );
}
