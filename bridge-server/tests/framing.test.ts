/**
 * Length-prefixed framing tests.
 *
 * Covers frameLengthPrefixed, readLengthPrefixed, and writeLengthPrefixed
 * with emphasis on chunk boundary splits, multiple messages in one chunk,
 * truncated streams, and zero-length payloads — the edge cases that cause
 * subtle bugs over real QUIC byte streams.
 */

import { describe, it, expect } from 'vitest';
import {
  frameLengthPrefixed,
  readLengthPrefixed,
  writeLengthPrefixed,
} from '../src/framing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ReadableStream that enqueues the given chunks in order and closes.
 */
function chunkedStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Collect all yielded values from readLengthPrefixed into an array. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const messages: Uint8Array[] = [];
  for await (const msg of readLengthPrefixed(stream)) {
    messages.push(msg);
  }
  return messages;
}

/** Shorthand for building a Uint8Array from numeric values. */
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// ---------------------------------------------------------------------------
// frameLengthPrefixed
// ---------------------------------------------------------------------------

describe('frameLengthPrefixed', () => {
  it('should prefix a payload with its 4-byte big-endian length', () => {
    const payload = bytes(0xca, 0xfe);
    const framed = frameLengthPrefixed(payload);

    expect(framed.length).toBe(6); // 4 prefix + 2 payload
    // Length prefix = 0x00000002
    expect(framed[0]).toBe(0);
    expect(framed[1]).toBe(0);
    expect(framed[2]).toBe(0);
    expect(framed[3]).toBe(2);
    // Payload preserved
    expect(framed[4]).toBe(0xca);
    expect(framed[5]).toBe(0xfe);
  });

  it('should handle an empty payload', () => {
    const framed = frameLengthPrefixed(new Uint8Array(0));

    expect(framed.length).toBe(4);
    const len = new DataView(framed.buffer).getUint32(0, false);
    expect(len).toBe(0);
  });

  it('should handle a large payload', () => {
    const payload = new Uint8Array(70_000);
    payload.fill(0x42);
    const framed = frameLengthPrefixed(payload);

    expect(framed.length).toBe(4 + 70_000);
    const len = new DataView(framed.buffer).getUint32(0, false);
    expect(len).toBe(70_000);
    // Check payload integrity
    expect(framed.slice(4)).toEqual(payload);
  });

  it('should produce a new buffer (not shared with input)', () => {
    const payload = bytes(1, 2, 3);
    const framed = frameLengthPrefixed(payload);
    // Mutating the original should not affect the framed output
    payload[0] = 0xff;
    expect(framed[4]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// readLengthPrefixed — single message scenarios
// ---------------------------------------------------------------------------

describe('readLengthPrefixed', () => {
  it('should read a single message delivered in one chunk', async () => {
    const payload = bytes(0xde, 0xad, 0xbe, 0xef);
    const framed = frameLengthPrefixed(payload);
    const messages = await collect(chunkedStream(framed));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
  });

  it('should read a zero-length message', async () => {
    const framed = frameLengthPrefixed(new Uint8Array(0));
    const messages = await collect(chunkedStream(framed));

    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBe(0);
  });

  it('should return nothing from an empty stream', async () => {
    const messages = await collect(chunkedStream());
    expect(messages).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Chunk boundary splits
  // -------------------------------------------------------------------------

  describe('chunk boundary splits', () => {
    it('should handle the length prefix split across two chunks', async () => {
      const payload = bytes(0x01, 0x02, 0x03);
      const framed = frameLengthPrefixed(payload);

      // Split in the middle of the 4-byte length prefix
      const chunk1 = framed.slice(0, 2); // first 2 bytes of prefix
      const chunk2 = framed.slice(2);    // remaining prefix + payload
      const messages = await collect(chunkedStream(chunk1, chunk2));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(payload);
    });

    it('should handle the payload split across two chunks', async () => {
      const payload = bytes(0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f);
      const framed = frameLengthPrefixed(payload);

      // Split after the prefix + 2 bytes of payload
      const chunk1 = framed.slice(0, 6); // prefix(4) + payload(2)
      const chunk2 = framed.slice(6);    // remaining 4 bytes of payload
      const messages = await collect(chunkedStream(chunk1, chunk2));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(payload);
    });

    it('should handle byte-at-a-time delivery', async () => {
      const payload = bytes(0xaa, 0xbb, 0xcc);
      const framed = frameLengthPrefixed(payload);

      // Each byte in its own chunk — worst-case fragmentation
      const chunks = Array.from(framed).map((b) => bytes(b));
      const messages = await collect(chunkedStream(...chunks));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(payload);
    });

    it('should handle prefix arriving one byte at a time, then full payload', async () => {
      const payload = bytes(0x10, 0x20);
      const framed = frameLengthPrefixed(payload);

      const messages = await collect(
        chunkedStream(
          framed.slice(0, 1),
          framed.slice(1, 2),
          framed.slice(2, 3),
          framed.slice(3, 4),
          framed.slice(4)
        )
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple messages
  // -------------------------------------------------------------------------

  describe('multiple messages', () => {
    it('should read two messages concatenated in one chunk', async () => {
      const p1 = bytes(0x01, 0x02);
      const p2 = bytes(0x03, 0x04, 0x05);
      const framed1 = frameLengthPrefixed(p1);
      const framed2 = frameLengthPrefixed(p2);

      // Both messages in a single chunk
      const combined = new Uint8Array(framed1.length + framed2.length);
      combined.set(framed1);
      combined.set(framed2, framed1.length);

      const messages = await collect(chunkedStream(combined));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(p1);
      expect(messages[1]).toEqual(p2);
    });

    it('should read three messages each in their own chunk', async () => {
      const payloads = [bytes(0xaa), bytes(0xbb, 0xcc), bytes(0xdd, 0xee, 0xff)];
      const frames = payloads.map(frameLengthPrefixed);

      const messages = await collect(chunkedStream(...frames));

      expect(messages).toHaveLength(3);
      payloads.forEach((p, i) => {
        expect(messages[i]).toEqual(p);
      });
    });

    it('should handle a split that falls between two messages', async () => {
      const p1 = bytes(0x11);
      const p2 = bytes(0x22);
      const f1 = frameLengthPrefixed(p1);
      const f2 = frameLengthPrefixed(p2);

      // Split exactly at the boundary between message 1 and message 2
      const messages = await collect(chunkedStream(f1, f2));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(p1);
      expect(messages[1]).toEqual(p2);
    });

    it('should handle a split that falls mid-way through second message prefix', async () => {
      const p1 = bytes(0x41, 0x42);
      const p2 = bytes(0x43, 0x44, 0x45);
      const f1 = frameLengthPrefixed(p1);
      const f2 = frameLengthPrefixed(p2);

      const combined = new Uint8Array(f1.length + f2.length);
      combined.set(f1);
      combined.set(f2, f1.length);

      // Split 2 bytes into the second message's prefix
      const splitPoint = f1.length + 2;
      const messages = await collect(
        chunkedStream(combined.slice(0, splitPoint), combined.slice(splitPoint))
      );

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(p1);
      expect(messages[1]).toEqual(p2);
    });

    it('should read many zero-length messages', async () => {
      const empty = frameLengthPrefixed(new Uint8Array(0));
      const combined = new Uint8Array(empty.length * 5);
      for (let i = 0; i < 5; i++) {
        combined.set(empty, i * empty.length);
      }

      const messages = await collect(chunkedStream(combined));
      expect(messages).toHaveLength(5);
      messages.forEach((m) => expect(m.length).toBe(0));
    });
  });

  // -------------------------------------------------------------------------
  // Truncated / incomplete streams
  // -------------------------------------------------------------------------

  describe('truncated streams', () => {
    it('should yield nothing when stream closes with partial length prefix', async () => {
      // Only 2 of the 4 prefix bytes, then stream closes
      const messages = await collect(chunkedStream(bytes(0x00, 0x00)));
      expect(messages).toHaveLength(0);
    });

    it('should yield nothing when stream closes with complete prefix but no payload', async () => {
      // Length prefix says 10 bytes but stream closes immediately
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, 10, false);

      const messages = await collect(chunkedStream(prefix));
      expect(messages).toHaveLength(0);
    });

    it('should yield nothing when stream closes with partial payload', async () => {
      // Length says 5 bytes but only 3 bytes of payload arrive
      const buf = new Uint8Array(4 + 3);
      new DataView(buf.buffer).setUint32(0, 5, false);
      buf[4] = 0xaa;
      buf[5] = 0xbb;
      buf[6] = 0xcc;

      const messages = await collect(chunkedStream(buf));
      expect(messages).toHaveLength(0);
    });

    it('should yield complete messages before a truncated final message', async () => {
      const p1 = bytes(0x01, 0x02);
      const f1 = frameLengthPrefixed(p1);

      // Second message: prefix says 4 bytes but only 2 arrive
      const partial = new Uint8Array(4 + 2);
      new DataView(partial.buffer).setUint32(0, 4, false);
      partial[4] = 0xaa;
      partial[5] = 0xbb;

      const combined = new Uint8Array(f1.length + partial.length);
      combined.set(f1);
      combined.set(partial, f1.length);

      const messages = await collect(chunkedStream(combined));

      // Only the first complete message should be yielded
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(p1);
    });

    it('should yield nothing from a stream that closes immediately', async () => {
      const messages = await collect(chunkedStream());
      expect(messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip with frameLengthPrefixed
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('should round-trip a single message through frame → read', async () => {
      const original = bytes(0xfe, 0xed, 0xfa, 0xce);
      const framed = frameLengthPrefixed(original);
      const messages = await collect(chunkedStream(framed));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(original);
    });

    it('should round-trip multiple messages of varying sizes', async () => {
      const payloads = [
        new Uint8Array(0),
        bytes(0x01),
        new Uint8Array(256).fill(0x42),
        new Uint8Array(1024).fill(0x99),
      ];

      const frames = payloads.map(frameLengthPrefixed);
      const total = frames.reduce((n, f) => n + f.length, 0);
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const f of frames) {
        combined.set(f, offset);
        offset += f.length;
      }

      const messages = await collect(chunkedStream(combined));

      expect(messages).toHaveLength(payloads.length);
      payloads.forEach((p, i) => {
        expect(messages[i]).toEqual(p);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// writeLengthPrefixed
// ---------------------------------------------------------------------------

describe('writeLengthPrefixed', () => {
  it('should write a length-prefixed frame to the writer', async () => {
    const written: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    });
    const writer = writable.getWriter();

    const payload = bytes(0xab, 0xcd);
    await writeLengthPrefixed(writer, payload);
    await writer.close();

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(frameLengthPrefixed(payload));
  });

  it('should produce output readable by readLengthPrefixed', async () => {
    // Pipe through a TransformStream to connect writer → reader
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const payload = bytes(0x10, 0x20, 0x30);

    // Write and close concurrently with reading to avoid backpressure deadlock
    const writePromise = (async () => {
      await writeLengthPrefixed(writer, payload);
      await writer.close();
    })();

    const messages = await collect(readable);
    await writePromise;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
  });
});
