# ADR: WebTransport for Video Stream Delivery

**Status:** Accepted  
**Date:** 2026-02-25  
**Deciders:** Engineering team

## Context

The VMS browser prototype bridges RTSP H.264 camera streams to browser clients for real-time viewing. The original implementation used WebSocket (TCP) to deliver all video streams over a single connection per client. As the system scaled to 4–16 simultaneous camera feeds, TCP's head-of-line blocking became a bottleneck: a single lost packet on one video stream stalled delivery of all other streams sharing the same connection.

We needed a transport that could multiplex independent video feeds without cross-stream interference, while staying within the browser's native API surface (no plugins, no WASM networking shims).

## Decision

Replace WebSocket with **WebTransport (HTTP/3 over QUIC)** using a single QUIC connection per client with multiplexed streams:

- **One bidirectional QUIC stream** for the control channel (subscribe/unsubscribe JSON messages, length-prefixed)
- **One server→client unidirectional QUIC stream per video subscription** for H.264 data

The server uses `@fails-components/webtransport` (Node.js HTTP/3 via libquiche). The client uses the browser-native `WebTransport` API (Chrome 114+).

## Architecture

```
┌──────────────────────────────────┐
│          Browser Client          │
│                                  │
│  WebTransport session            │
│  ├─ BiDi stream #0 (control)     │  ← subscribe/unsubscribe JSON
│  ├─ UniDi stream (stream 1)      │  ← H.264 frames for camera 1
│  ├─ UniDi stream (stream 2)      │  ← H.264 frames for camera 2
│  └─ UniDi stream (stream N)      │  ← H.264 frames for camera N
│                                  │
└──────────┬───────────────────────┘
           │ QUIC (UDP)
           ▼
┌──────────────────────────────────┐
│        Bridge Server             │
│                                  │
│  HTTP/3 (port 9001)              │  WebTransport sessions
│  HTTP/1.1 (port 9000)            │  REST API + cert hash
│                                  │
│  StreamManager                   │
│  ├─ RTSP Client (FFmpeg) ───────►│  stream 1
│  ├─ RTSP Client (FFmpeg) ───────►│  stream 2
│  └─ RTSP Client (FFmpeg) ───────►│  stream N
└──────────────────────────────────┘
```

### Wire Protocol

QUIC streams are byte-oriented (no message boundaries), so all messages use 4-byte big-endian length-prefix framing:

```
+──────────+───────────+
│ Length   │ Payload   │
│ 4 bytes  │ N bytes   │
│ uint32BE │           │
+──────────+───────────+
```

Video payloads use the same 12-byte binary header as before:

```
+─────────+──────────+───────────+────────+─────────────+
│ Version │ StreamID │ Timestamp │ Flags  │ H.264 NALUs │
│ 1 byte  │ 2 bytes  │ 8 bytes   │ 1 byte │ variable    │
+─────────+──────────+───────────+────────+─────────────+
```

### TLS Certificate Management

WebTransport requires TLS. The bridge server generates a self-signed ECDSA P-256 certificate at startup (≤14 days validity, Chrome's maximum for pinned certs). The SHA-256 fingerprint is exposed via `GET /cert-hash` on the REST API. The browser client fetches this hash and passes it to `new WebTransport(url, { serverCertificateHashes })` for certificate pinning — no CA trust chain needed for local development.

## Benefits

### 1. No Head-of-Line Blocking Between Streams

This is the primary motivation. With WebSocket over TCP, all video streams share one ordered byte stream. If a TCP segment carrying camera 3's data is lost, cameras 1, 2, and 4 are blocked until retransmission completes — even though their data is already in the kernel buffer.

With WebTransport, each video subscription gets its own QUIC stream. Packet loss on one stream only stalls that stream. The other camera feeds continue to deliver frames unimpeded. For a VMS displaying 4–16 cameras simultaneously, this directly reduces visible stutter.

### 2. Independent Flow Control Per Stream

Each QUIC stream has its own flow control window. A slow-decoding client that falls behind on one high-bitrate camera feed doesn't back-pressure other feeds. The server detects per-stream backpressure via `writer.desiredSize` and drops non-keyframe video data for congested streams while continuing to serve non-congested ones at full rate.

With WebSocket, backpressure was all-or-nothing: if the TCP send buffer filled up, all streams stalled together.

### 3. Connection Multiplexing (Single Socket)

Despite having independent streams, everything runs over a single QUIC connection (one UDP socket). This means:

- One TLS handshake, not N
- One connection setup, not N
- Shared congestion control at the connection level
- No additional NAT/firewall entries needed

The original WebSocket approach also used a single connection, so this preserves that operational simplicity while gaining stream independence.

### 4. Better Congestion Recovery

QUIC's loss recovery is per-stream. When the network drops packets, the affected stream gets rapid redelivery while unaffected streams are untouched. TCP treats the entire connection as a single loss domain — one lost segment triggers congestion control (window reduction) for all data.

For video, this means a brief spike in packet loss degrades one camera feed instead of all of them.

### 5. 0-RTT Reconnection Potential

QUIC supports 0-RTT session resumption. After the initial connection, reconnects can begin sending data immediately without waiting for a full handshake. The client already implements exponential backoff reconnection — with QUIC, resumed connections start streaming faster.

## Trade-offs

### Browser Compatibility

WebTransport requires Chrome 114+ (or Edge 114+). Firefox and Safari do not yet support it as of early 2026. This is acceptable for a Chrome-first prototype (the WebGPU rendering path already requires Chrome). The old `ws-receiver.ts` is retained as a potential fallback.

### Server Complexity

The `@fails-components/webtransport` library adds a native dependency (libquiche compiled via prebuild). This increases build complexity compared to the pure-JavaScript `ws` package. The library is actively maintained (last release: Feb 2026) and handles the HTTP/3 + QUIC stack.

### TLS Certificate Management

WebTransport mandates TLS. For local development, we generate a self-signed ECDSA P-256 certificate at every server startup and expose its hash for client pinning. This adds a startup step and requires OpenSSL on the host. In production, a proper CA-signed certificate would replace this.

### Length-Prefix Framing Overhead

WebSocket provides message boundaries natively; QUIC streams do not. We add a 4-byte length prefix to every message. For video frames averaging 10–50 KB, this is negligible overhead (<0.04%). For the JSON control messages, it is proportionally larger but these are infrequent.

## Alternatives Considered

### Multiple WebSocket connections (one per stream)

Would solve head-of-line blocking via separate TCP connections but at the cost of N TLS handshakes, N TCP slow-start phases, and N connections competing without shared congestion state. Browsers also limit concurrent connections per origin (6 in most browsers), which caps the stream count.

### WebSocket with application-level prioritization

Could deprioritize lagging streams at the application layer, but cannot fix kernel-level TCP head-of-line blocking. Frames already in the TCP send buffer are delivered in order regardless of application-level priority.

### WebRTC DataChannels

SCTP over DTLS-SRTP provides ordered/unordered channels over UDP. However, WebRTC requires a complex signaling setup (offer/answer/ICE) designed for peer-to-peer, not client-server. WebTransport provides a simpler client-server model with the same QUIC-based benefits.

### Raw UDP via WebSocket proxy

Not possible within browser security constraints. Browsers cannot open raw UDP sockets.

## Implementation Details

| Component | File | Role |
|-----------|------|------|
| Certificate generation | `bridge-server/src/cert-utils.ts` | ECDSA P-256 cert + SHA-256 hash |
| Length-prefix framing | `bridge-server/src/framing.ts` | 4-byte framing for QUIC byte streams |
| Server entry point | `bridge-server/src/index.ts` | Http3Server + REST API setup |
| Stream manager | `bridge-server/src/stream-manager.ts` | Per-client sessions, per-stream writers |
| Client receiver | `client/src/stream/wt-receiver.ts` | WebTransport session, cert pinning, stream demux |
| Decode pipeline | `client/src/stream/stream-pipeline.ts` | Transport-agnostic `StreamReceiver` interface |

### Port Allocation

| Port | Protocol | Purpose |
|------|----------|---------|
| 9000 | HTTP/1.1 | REST API (stream list, cert hash, health) |
| 9001 | HTTP/3 (QUIC) | WebTransport sessions |
| 8554 | RTSP | MediaMTX camera streams (Docker) |

## Consequences

- All existing tests (41) continue to pass — the H.264 parser and grid layout tests are transport-agnostic
- The binary video frame protocol (12-byte header) is unchanged; only the delivery mechanism changed
- The client's `StreamPipeline` now accepts a `StreamReceiver` interface, making it transport-agnostic for future fallback implementations
- Server startup takes ~100ms longer due to TLS certificate generation
- The `ws` npm dependency is removed from the bridge server; `@fails-components/webtransport` replaces it
