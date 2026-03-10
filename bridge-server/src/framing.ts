/**
 * Length-prefixed framing for WebTransport streams.
 *
 * QUIC streams are byte-oriented with no inherent message boundaries.
 * This module provides framing via a 4-byte big-endian length prefix
 * before each message, enabling discrete message delivery over streams.
 *
 * Wire format per message:
 * ```
 * +----------+---------+
 * | Length   | Payload |
 * | 4 bytes  | N bytes |
 * | uint32BE |         |
 * +----------+---------+
 * ```
 */

/**
 * Build a length-prefixed frame from arbitrary payload data.
 *
 * @param payload - Raw payload bytes
 * @returns New buffer with 4-byte length prefix + payload
 */
export function frameLengthPrefixed(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, 4);
  return frame;
}

/**
 * Concatenate two Uint8Arrays into a new array.
 *
 * @param a - First array
 * @param b - Second array
 * @returns Concatenated array
 */
function concat(a: Uint8Array, b: Uint8Array<ArrayBufferLike>): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

/**
 * Async generator that reads length-prefixed messages from a ReadableStream.
 *
 * Buffers incoming chunks and yields complete messages as they become
 * available. Handles chunk boundaries that don't align with message
 * boundaries — a common occurrence with QUIC streams.
 *
 * @param readable - Source byte stream (e.g., from a WebTransport bidirectional stream)
 * @yields Complete message payloads (without the length prefix)
 */
/** Maximum allowed frame size (50 MB) — reject frames beyond this as corrupt */
const MAX_FRAME_SIZE = 50 * 1024 * 1024;

export async function* readLengthPrefixed(
  readable: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = readable.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  try {
    while (true) {
      // Read until we have at least 4 bytes for the length prefix
      while (buffer.length < 4) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer = concat(buffer, value);
      }

      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset
      ).getUint32(0, false);

      if (length > MAX_FRAME_SIZE) {
        throw new RangeError(
          `Frame length ${length} exceeds maximum ${MAX_FRAME_SIZE} — stream likely out of sync`
        );
      }

      // Read until we have the full message
      while (buffer.length < 4 + length) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer = concat(buffer, value);
      }

      // Extract the message and advance the buffer
      yield buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Write a length-prefixed message to a WritableStreamDefaultWriter.
 *
 * @param writer - Stream writer to send data on
 * @param data - Payload to frame and send
 * @returns Promise that resolves when the write is accepted
 */
export async function writeLengthPrefixed(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  data: Uint8Array
): Promise<void> {
  const frame = frameLengthPrefixed(data);
  await writer.write(frame);
}
