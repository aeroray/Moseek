/// <reference types="vite/client" />

declare module "*.css" {
  const stylesheet: string;
  export default stylesheet;
}

/**
 * The app version, injected by `vite.config.ts` from `package.json`.
 *
 * Declared here rather than read from package.json at runtime: the settings page only needs the
 * number, and importing the manifest into the bundle would ship the whole dependency list with it.
 */
declare const __APP_VERSION__: string;
