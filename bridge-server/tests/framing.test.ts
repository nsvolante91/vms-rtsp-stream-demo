/**
 * Framing Tests
 *
 * Tests for length-prefixed message framing used over QUIC/WebTransport streams.
 * Covers frameLengthPrefixed, readLengthPrefixed, and writeLengthPrefixed,
 * including chunk boundary splits, multiple messages in one chunk, and
 * truncated prefixes/payloads.
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
 * Build a ReadableStream from an array of Uint8Array chunks.
 */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let chunkIndex = 0;
  return new ReadableStream({
    pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex++]);
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Collect all messages yielded by readLengthPrefixed into an array.
 */
async function collectMessages(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array[]> {
  const messages: Uint8Array[] = [];
  for await (const msg of readLengthPrefixed(stream)) {
    messages.push(msg);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// frameLengthPrefixed
// ---------------------------------------------------------------------------

describe('frameLengthPrefixed', () => {
  it('should prepend a 4-byte big-endian length prefix', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const frame = frameLengthPrefixed(payload);

    // Total length: 4-byte prefix + 3-byte payload
    expect(frame.length).toBe(7);

    // Length prefix encodes payload length as big-endian uint32
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, false)).toBe(3);

    // Payload follows the prefix unchanged
    expect(Array.from(frame.slice(4))).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('should handle an empty payload', () => {
    const frame = frameLengthPrefixed(new Uint8Array(0));
    expect(frame.length).toBe(4);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, false)).toBe(0);
  });

  it('should handle a single-byte payload', () => {
    const frame = frameLengthPrefixed(new Uint8Array([0x42]));
    expect(frame.length).toBe(5);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, false)).toBe(1);
    expect(frame[4]).toBe(0x42);
  });

  it('should not share memory with the original payload', () => {
    const payload = new Uint8Array([0x01, 0x02]);
    const frame = frameLengthPrefixed(payload);
    payload[0] = 0xff; // mutate original
    expect(frame[4]).toBe(0x01); // frame is unaffected
  });
});

// ---------------------------------------------------------------------------
// readLengthPrefixed – single message
// ---------------------------------------------------------------------------

describe('readLengthPrefixed – single message', () => {
  it('should decode a single framed message delivered in one chunk', async () => {
    const payload = new Uint8Array([0x10, 0x20, 0x30]);
    const frame = frameLengthPrefixed(payload);
    const messages = await collectMessages(streamFromChunks([frame]));

    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0x10, 0x20, 0x30]);
  });

  it('should yield an empty payload for a zero-length message', async () => {
    const frame = frameLengthPrefixed(new Uint8Array(0));
    const messages = await collectMessages(streamFromChunks([frame]));

    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBe(0);
  });

  it('should yield nothing if the stream ends immediately', async () => {
    const messages = await collectMessages(streamFromChunks([]));
    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readLengthPrefixed – chunk boundary splits
// ---------------------------------------------------------------------------

describe('readLengthPrefixed – chunk boundary splits', () => {
  it('should reassemble a message split across the 4-byte prefix boundary', async () => {
    // Split the 4-byte prefix itself across two chunks
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const frame = frameLengthPrefixed(payload);

    // Deliver first 2 bytes (half the prefix), then the rest
    const chunk1 = frame.slice(0, 2);
    const chunk2 = frame.slice(2);

    const messages = await collectMessages(streamFromChunks([chunk1, chunk2]));
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('should reassemble a message split between prefix and payload', async () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const frame = frameLengthPrefixed(payload);

    // Deliver only the prefix, then the payload
    const chunk1 = frame.slice(0, 4);
    const chunk2 = frame.slice(4);

    const messages = await collectMessages(streamFromChunks([chunk1, chunk2]));
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
  });

  it('should reassemble a message split in the middle of the payload', async () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const frame = frameLengthPrefixed(payload);

    // Split the payload into 1-byte chunks after the prefix
    const chunks = [
      frame.slice(0, 4),  // prefix
      frame.slice(4, 5),  // 0xaa
      frame.slice(5, 6),  // 0xbb
      frame.slice(6, 7),  // 0xcc
      frame.slice(7),     // 0xdd
    ];

    const messages = await collectMessages(streamFromChunks(chunks));
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('should handle the length prefix split across 4 individual byte chunks', async () => {
    const payload = new Uint8Array([0xff]);
    const frame = frameLengthPrefixed(payload);

    // Deliver the 4-byte prefix one byte at a time
    const chunks = [
      frame.slice(0, 1),
      frame.slice(1, 2),
      frame.slice(2, 3),
      frame.slice(3, 4),
      frame.slice(4),
    ];

    const messages = await collectMessages(streamFromChunks(chunks));
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0xff]);
  });
});

// ---------------------------------------------------------------------------
// readLengthPrefixed – multiple messages per chunk
// ---------------------------------------------------------------------------

describe('readLengthPrefixed – multiple messages in one chunk', () => {
  it('should decode two messages delivered in a single chunk', async () => {
    const msg1 = new Uint8Array([0x01]);
    const msg2 = new Uint8Array([0x02, 0x03]);

    const combined = new Uint8Array([
      ...frameLengthPrefixed(msg1),
      ...frameLengthPrefixed(msg2),
    ]);

    const messages = await collectMessages(streamFromChunks([combined]));
    expect(messages).toHaveLength(2);
    expect(Array.from(messages[0])).toEqual([0x01]);
    expect(Array.from(messages[1])).toEqual([0x02, 0x03]);
  });

  it('should decode many messages delivered in a single chunk', async () => {
    const payloads = [
      new Uint8Array([0x10]),
      new Uint8Array([0x20, 0x21]),
      new Uint8Array([0x30, 0x31, 0x32]),
      new Uint8Array([0x40]),
    ];

    const combined = new Uint8Array(
      payloads.reduce<number[]>(
        (acc, p) => [...acc, ...frameLengthPrefixed(p)],
        []
      )
    );

    const messages = await collectMessages(streamFromChunks([combined]));
    expect(messages).toHaveLength(4);
    payloads.forEach((payload, index) => {
      expect(Array.from(messages[index])).toEqual(Array.from(payload));
    });
  });

  it('should decode messages when chunk boundaries straddle message boundaries', async () => {
    const msg1 = new Uint8Array([0xaa, 0xbb]);
    const msg2 = new Uint8Array([0xcc, 0xdd]);
    const allBytes = new Uint8Array([
      ...frameLengthPrefixed(msg1),
      ...frameLengthPrefixed(msg2),
    ]);
    // Total = 4+2 + 4+2 = 12 bytes; split at byte 5 (inside msg1 payload)
    const chunk1 = allBytes.slice(0, 5);
    const chunk2 = allBytes.slice(5);

    const messages = await collectMessages(streamFromChunks([chunk1, chunk2]));
    expect(messages).toHaveLength(2);
    expect(Array.from(messages[0])).toEqual([0xaa, 0xbb]);
    expect(Array.from(messages[1])).toEqual([0xcc, 0xdd]);
  });
});

// ---------------------------------------------------------------------------
// readLengthPrefixed – truncated / incomplete streams
// ---------------------------------------------------------------------------

describe('readLengthPrefixed – truncated streams', () => {
  it('should yield nothing when the stream ends mid-prefix (< 4 bytes)', async () => {
    // Only 3 bytes — not enough to read the length prefix
    const truncated = new Uint8Array([0x00, 0x00, 0x05]);
    const messages = await collectMessages(streamFromChunks([truncated]));
    expect(messages).toHaveLength(0);
  });

  it('should yield nothing when the stream ends after a complete prefix but before the payload', async () => {
    // Length prefix says 5 bytes, but stream ends immediately after prefix
    const truncated = new Uint8Array([0x00, 0x00, 0x00, 0x05]);
    const messages = await collectMessages(streamFromChunks([truncated]));
    expect(messages).toHaveLength(0);
  });

  it('should yield completed messages before dropping an incomplete trailing message', async () => {
    const complete = frameLengthPrefixed(new Uint8Array([0x01, 0x02]));
    // Incomplete: prefix says 3 bytes but only 2 are delivered
    const incompleteFrame = new Uint8Array([
      ...new Uint8Array([0x00, 0x00, 0x00, 0x03]),
      0xaa, 0xbb,
    ]);

    const messages = await collectMessages(
      streamFromChunks([complete, incompleteFrame])
    );
    expect(messages).toHaveLength(1);
    expect(Array.from(messages[0])).toEqual([0x01, 0x02]);
  });
});

// ---------------------------------------------------------------------------
// writeLengthPrefixed
// ---------------------------------------------------------------------------

describe('writeLengthPrefixed', () => {
  it('should write a framed message to the provided writer', async () => {
    const written: Uint8Array[] = [];
    const writer = {
      write: async (chunk: Uint8Array) => {
        written.push(chunk);
      },
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    await writeLengthPrefixed(writer, payload);

    expect(written).toHaveLength(1);
    const frame = written[0];
    expect(frame.length).toBe(7);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, false)).toBe(3);
    expect(Array.from(frame.slice(4))).toEqual([0x11, 0x22, 0x33]);
  });
});
