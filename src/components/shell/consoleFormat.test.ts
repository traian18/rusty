import { describe, expect, it } from "vitest";
import { formatConsoleArgument, formatConsoleEntry, truncateConsoleText } from "./consoleFormat";

describe("truncateConsoleText", () => {
  it("passes a string at exactly the limit through unchanged", () => {
    const text = "a".repeat(2000);
    expect(truncateConsoleText(text)).toBe(text);
  });

  it("truncates one character over the limit with a suffix", () => {
    const text = "a".repeat(2001);
    const result = truncateConsoleText(text);
    expect(result).toBe(`${"a".repeat(2000)}… [1 chars omitted]`);
  });

  it("honours a custom limit", () => {
    expect(truncateConsoleText("abcdef", 3)).toBe("abc… [3 chars omitted]");
  });
});

describe("formatConsoleArgument", () => {
  it("passes short strings through", () => {
    expect(formatConsoleArgument("hello")).toBe("hello");
  });

  it("truncates a long string", () => {
    const text = "x".repeat(2500);
    expect(formatConsoleArgument(text)).toContain("chars omitted");
  });

  it("formats primitives via String()", () => {
    expect(formatConsoleArgument(42)).toBe("42");
    expect(formatConsoleArgument(true)).toBe("true");
    expect(formatConsoleArgument(null)).toBe("null");
    expect(formatConsoleArgument(undefined)).toBe("undefined");
  });

  it("prefers an Error's stack, falling back to its message", () => {
    const withStack = new Error("boom");
    expect(formatConsoleArgument(withStack)).toBe(truncateConsoleText(withStack.stack!));

    const withoutStack = new Error("boom");
    withoutStack.stack = undefined;
    expect(formatConsoleArgument(withoutStack)).toBe("boom");
  });

  it("serializes a plain object", () => {
    expect(formatConsoleArgument({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("replaces a circular reference with [Circular]", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    expect(formatConsoleArgument(obj)).toContain("[Circular]");
  });

  it("truncates an array longer than 30 items", () => {
    const arr = Array.from({ length: 40 }, (_, i) => i);
    const result = formatConsoleArgument(arr);
    expect(result).toContain("[10 items omitted]");
    expect(JSON.parse(result)).toHaveLength(31); // 30 kept + 1 omission marker
  });

  it("truncates after visiting more than 80 nested entries", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 200; i++) big[`key${i}`] = i;
    expect(formatConsoleArgument(big)).toContain("[Entry truncated]");
  });

  it("falls back to a placeholder when JSON.stringify throws", () => {
    class Weird {
      get bad(): never {
        throw new Error("nope");
      }
    }
    const instance = new Weird();
    // Force JSON.stringify to throw by giving the object an accessor that throws.
    Object.defineProperty(instance, "bad", { enumerable: true, get() { throw new Error("nope"); } });
    expect(formatConsoleArgument(instance)).toBe("[Unserializable Weird]");
  });

  it("truncates long nested string values inside an object", () => {
    const result = formatConsoleArgument({ text: "y".repeat(600) });
    expect(result).toContain("chars omitted");
  });
});

describe("formatConsoleEntry", () => {
  it("joins multiple arguments with a space", () => {
    expect(formatConsoleEntry(["hello", 42, true])).toBe("hello 42 true");
  });

  it("truncates the joined entry at the entry limit", () => {
    const args = [ "z".repeat(9000) ];
    const result = formatConsoleEntry(args);
    expect(result.length).toBeLessThan(9000);
    expect(result).toContain("chars omitted");
  });

  it("handles an empty argument list", () => {
    expect(formatConsoleEntry([])).toBe("");
  });
});
