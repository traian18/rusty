/**
 * Public surface of the tab system — the non-React half only.
 *
 * `views.tsx` is deliberately NOT re-exported here: importing it pulls in every
 * tab component, and `src/store/**` imports from this module. Consumers that
 * need the render table import `./views` directly, and only the view layer
 * does. `src/tabs/layering.test.ts` enforces this.
 */

export * from "./types";
export * from "./identity";
export * from "./policy";
export * from "./closeGuards";
export * from "./transitions";
export * from "./effects";
export * from "./closeRequests";
