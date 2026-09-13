/**
 * Pure console-argument formatting for the Dev Logs terminal tab.
 *
 * Extracted verbatim from App.tsx (previously inline module-level helpers
 * used only by the console interceptor). These run on every `console.log`,
 * `console.error` and `console.warn` call in the application via
 * `DevLogBridge`, and had never been tested.
 */

const MAX_CONSOLE_ARGUMENT_LENGTH = 2_000;
const MAX_CONSOLE_ENTRY_LENGTH = 8_000;
const MAX_CONSOLE_OBJECT_ENTRIES = 80;

export function truncateConsoleText(value: string, limit = MAX_CONSOLE_ARGUMENT_LENGTH): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length - limit} chars omitted]`;
}

export function formatConsoleArgument(value: unknown): string {
  if (typeof value === "string") return truncateConsoleText(value);
  if (value instanceof Error) return truncateConsoleText(value.stack || value.message);
  if (value === null || typeof value !== "object") return String(value);

  const seen = new WeakSet<object>();
  let visitedEntries = 0;
  try {
    const serialized = JSON.stringify(value, (key, nestedValue) => {
      if (key) visitedEntries += 1;
      if (visitedEntries > MAX_CONSOLE_OBJECT_ENTRIES) return "[Entry truncated]";
      if (typeof nestedValue === "string") return truncateConsoleText(nestedValue, 500);
      if (!nestedValue || typeof nestedValue !== "object") return nestedValue;
      if (seen.has(nestedValue)) return "[Circular]";
      seen.add(nestedValue);
      if (Array.isArray(nestedValue) && nestedValue.length > 30) {
        return [...nestedValue.slice(0, 30), `[${nestedValue.length - 30} items omitted]`];
      }
      return nestedValue;
    });
    return truncateConsoleText(serialized || String(value));
  } catch {
    return `[Unserializable ${value.constructor?.name || "object"}]`;
  }
}

export function formatConsoleEntry(args: unknown[]): string {
  return truncateConsoleText(args.map(formatConsoleArgument).join(" "), MAX_CONSOLE_ENTRY_LENGTH);
}
