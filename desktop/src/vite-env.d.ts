/// <reference types="vite/client" />

// Without this, `import markUrl from "./assets/mark.png"` is a type error:
// tsc has no idea what a .png resolves to, and the desktop's tsconfig sets
// noUnusedLocals and friends, so it fails the build rather than warning.
//
// The web client gets these declarations from its own vite-env.d.ts. The
// desktop had none because nothing here had imported an asset before — the
// first-run screen drew its mark as a CSS gradient with the letters "SN" in
// it, which is a placeholder that shipped.
