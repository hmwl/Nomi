import { describe, expect, it } from "vitest";
import { decodeTransportValue, encodeTransportValue } from "./http";

describe("web HTTP transport values", () => {
  it("round-trips binary payloads nested in JSON", () => {
    const encoded = encodeTransportValue({
      chunk: new Uint8Array([1, 2, 3, 255]),
      items: [Buffer.from("hello")],
    });
    expect(encoded).toEqual({
      chunk: { __nomiBytesBase64: "AQID/w==" },
      items: [{ __nomiBytesBase64: "aGVsbG8=" }],
    });
    const decoded = decodeTransportValue(encoded) as { chunk: Buffer; items: Buffer[] };
    expect(Buffer.from(decoded.chunk)).toEqual(Buffer.from([1, 2, 3, 255]));
    expect(Buffer.from(decoded.items[0])).toEqual(Buffer.from("hello"));
  });
});

