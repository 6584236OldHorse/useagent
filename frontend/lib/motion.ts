/**
 * The one easing curve for UI motion, shared by motion/react animations. The CSS
 * side is `--ease-out` in styles/theme.css (the same four numbers), so a reveal
 * animated in CSS and one animated in JS settle the same way.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
