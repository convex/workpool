import { describe, expect, it } from "vitest";
import { layoutPayload } from "./payload.js";

const big = (n: number) => "x".repeat(n);

describe("layoutPayload", () => {
  it("keeps small args and context on the work document", () => {
    expect(layoutPayload("fn", { a: 1 }, "ctx")).toEqual({
      fnArgs: { a: 1 },
      context: "ctx",
    });
  });

  it("moves large args and context into one payload document", () => {
    const layout = layoutPayload("fn", { a: big(20_000) }, big(20_000));
    expect(layout.fnArgs).toBeUndefined();
    expect(layout.context).toBeUndefined();
    expect(layout.payload).toEqual({
      args: { a: big(20_000) },
      context: big(20_000),
    });
  });

  it("throws when args and context each fit but not together", () => {
    // Each is under MAX_DOC_SIZE, but both go in one payload document.
    expect(() =>
      layoutPayload("fn", { a: big(600_000) }, big(600_000)),
    ).toThrow(/too large together/);
  });

  it("allows a large context next to small args", () => {
    // Small args stay on the work document, so only the context is in the
    // payload document.
    const layout = layoutPayload("fn", { a: 1 }, big(900_000));
    expect(layout.fnArgs).toEqual({ a: 1 });
    expect(layout.payload).toEqual({ context: big(900_000) });
  });
});
