# ADR: WebTransport for Video Stream Delivery (with WebSocket Fallback)

**Status:** Accepted  
**Date:** 2026-02-26  
**Deciders:** Engineering team

## Context

The VMS browser prototype bridges RTSP H.264 camera streams to browser clients for real-time viewing. The original implementation used WebSocket (TCP) to deliver all video streams over a single connection per client. As the system scaled to 4–16 simultaneous camera feeds, TCP's head-of-line blocking became a bottleneck: a single lost packet on one video stream stalled delivery of all other streams sharing the same connection.

We needed a transport that could multiplex independent video feeds without cross-stream interference, while staying within the browser's native API surface (no plugins, no WASM networking shims). At the same time, WebTransport is only available in Chromium-based browsers — Safari and Firefox do not support it as of early 2026. A WebSocket fallback is required for cross-browser compatibility.

## Decision

Use **WebTransport (HTTP/3 over QUIC)** as the primary transport with an automatic **WebSocket fallback** for browsers that lack WebTransport support:

**Primary transport (WebTransport):**
- **One bidirectional QUIC stream** for the control channel (subscribe/unsubscribe JSON messages, length-prefixed)
- **One server→client unidirectional QUIC stream** shared across all video subscriptions for H.264 data (multiplexed via the binary protocol's streamId header)

**Fallback transport (WebSocket):**
- **One WebSocket connection** on `ws://<host>:9000/ws` for both control (JSON text) and video data (binary frames)
- Same 12-byte binary frame header as WebTransport, but without length-prefix framing (WebSocket provides native message boundaries)

The server uses `@fails-components/webtransport` (Node.js HTTP/3 via libquiche) for QUIC and `ws` for the WebSocket fallback. The client detects `typeof WebTransport !== 'undefined'` at startup and selects the appropriate receiver.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Browser Client                        │
│                                                          │
│  Transport auto-detection:                               │
│  ┌─ WebTransport (Chrome 114+) ─────────────────────┐   │
│  │  QUIC session                                     │   │
│  │  ├─ BiDi stream #0 (control) ← JSON sub/unsub    │   │
│  │  └─ UniDi stream (video)     ← H.264 binary      │   │
│  └───────────────────────────────────────────────────┘   │
│  ┌─ WebSocket fallback (Safari, Firefox) ────────────┐   │
│  │  ws://<host>:9000/ws                              │   │
│  │  ├─ Text messages (control)  ← JSON sub/unsub    │   │
│  │  └─ Binary messages (video)  ← H.264 binary      │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  StreamReceiver interface ──► StreamPipeline ──► Decode   │
│                                                          │
└──────────┬───────────────────────────────────────────────┘
           │ QUIC (UDP) or WebSocket (TCP)
           ▼
┌──────────────────────────────────────────────────────────┐
│                    Bridge Server                         │
│                                                          │
│  HTTP/3 (port 9001, 0.0.0.0)    WebTransport sessions   │
│  HTTP/1.1 (port 9000, 0.0.0.0)  REST API + WebSocket    │
│                                                          │
│  StreamManager (transport-agnostic)                      │
│  ├─ WTClient (WebTransport sessions)                     │
│  ├─ WSClient (WebSocket connections)                     │
│  │                                                       │
│  ├─ RTSP Client (FFmpeg) ───────► stream 1               │
│  ├─ RTSP Client (FFmpeg) ───────► stream 2               │
│  └─ RTSP Client (FFmpeg) ───────► stream N               │
└──────────────────────────────────────────────────────────┘
```

### Wire Protocol

Both transports use the same 12-byte binary video frame header:

```
+─────────+──────────+───────────+────────+─────────────+
│ Version │ StreamID │ Timestamp │ Flags  │ H.264 NALUs │
│ 1 byte  │ 2 bytes  │ 8 bytes   │ 1 byte │ variable    │
+─────────+──────────+───────────+────────+─────────────+
```

**Framing differences by transport:**

- **WebTransport:** QUIC streams are byte-oriented (no message boundaries), so all messages use 4-byte big-endian length-prefix framing. Control messages (JSON) and video frames both get this prefix.
- **WebSocket:** Native message boundaries, so frames are sent raw without length-prefix. Control messages are JSON text; video data is binary.

```
WebTransport framing:       WebSocket framing:
+──────────+───────────+    +───────────+
│ Length   │ Payload   │    │ Payload   │
│ 4 bytes  │ N bytes   │    │ N bytes   │
│ uint32BE │           │    │ (binary)  │
+──────────+───────────+    +───────────+
```

### TLS Certificate Management

WebTransport requires TLS. The bridge server generates a self-signed ECDSA P-256 certificate at startup (≤14 days validity, Chrome's maximum for pinned certs). The certificate's SAN entries automatically include `localhost`, `127.0.0.1`, and **all local network IPv4 addresses** (discovered via `os.networkInterfaces()`), enabling access from other devices on the LAN. Additional SANs can be added via the `BRIDGE_SAN` environment variable.

The SHA-256 fingerprint is exposed via `GET /cert-hash` on the REST API. The browser client fetches this hash and passes it to `new WebTransport(url, { serverCertificateHashes })` for certificate pinning — no CA trust chain needed for local development. The WebSocket fallback does not require certificate pinning since it uses plain HTTP.

### Network Accessibility

All servers bind to `0.0.0.0` (not localhost) so they are reachable from other devices on the network:
- HTTP REST API + WebSocket on port 9000
- WebTransport (HTTP/3 QUIC) on port 9001
- The Vite dev server also binds to `0.0.0.0` on port 5173

The client dynamically derives the bridge server hostname from `window.location.hostname`, so when accessed via a LAN IP (e.g., `http://192.168.1.42:5173`), it automatically connects to the bridge at that same IP.

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

WebTransport requires Chrome 114+ (or Edge 114+). Firefox and Safari do not yet support it as of early 2026. Rather than restricting to Chrome-only, the system now auto-detects WebTransport availability and falls back to WebSocket for unsupported browsers. This means:

- **Chrome/Edge 114+**: WebTransport (QUIC) — full benefits of per-stream flow control and no head-of-line blocking
- **Safari 17+, Firefox**: WebSocket (TCP) — head-of-line blocking applies, but video decoding (WebCodecs) and rendering (Canvas2D) still work
- **Older browsers**: Unsupported (requires WebCodecs `VideoDecoder`)

The WebGPU `importExternalTexture` rendering path remains Chrome-only; Safari and Firefox use the Canvas2D fallback renderer.

### Server Complexity

The bridge server now carries two transport dependencies: `@fails-components/webtransport` (libquiche native addon for HTTP/3) and `ws` (pure JavaScript WebSocket). The `StreamManager` uses a transport-agnostic `VideoSubscription` interface with `send()` and `isBackpressured()` callbacks, keeping the RTSP→client distribution logic unified regardless of transport.

### TLS Certificate Management

WebTransport mandates TLS. For local development, we generate a self-signed ECDSA P-256 certificate at every server startup and expose its hash for client pinning. The certificate now automatically includes all local IPv4 addresses in its SAN entries, supporting LAN access without manual configuration. Additional SANs can be added via `BRIDGE_SAN` env var. In production, a proper CA-signed certificate would replace this.

The WebSocket fallback uses plain HTTP (no TLS), which avoids certificate complexity for browsers that don't support WebTransport.

### Length-Prefix Framing Overhead

WebSocket provides message boundaries natively; QUIC streams do not. WebTransport messages get a 4-byte length prefix; WebSocket messages do not. For video frames averaging 10–50 KB, this is negligible overhead (<0.04%). For the JSON control messages, it is proportionally larger but these are infrequent.

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
| Certificate generation | `bridge-server/src/cert-utils.ts` | ECDSA P-256 cert + SHA-256 hash, auto-discovers local IPs for SAN |
| Length-prefix framing | `bridge-server/src/framing.ts` | 4-byte framing for QUIC byte streams (not used by WebSocket path) |
| WebSocket handler | `bridge-server/src/ws-handler.ts` | Attaches WebSocket server at `/ws` on the HTTP server |
| Server entry point | `bridge-server/src/index.ts` | Http3Server + REST API + WebSocket setup |
| Stream manager | `bridge-server/src/stream-manager.ts` | Transport-agnostic client/subscription management (WTClient + WSClient) |
| WebTransport receiver | `client/src/stream/wt-receiver.ts` | WebTransport session, cert pinning, stream demux |
| WebSocket receiver | `client/src/stream/ws-receiver.ts` | WebSocket connection, binary frame parsing, reconnection |
| Decode pipeline | `client/src/stream/stream-pipeline.ts` | Transport-agnostic `StreamReceiver` interface |
| App entry point | `client/src/main.ts` | Transport auto-detection, WebTransport → WebSocket fallback |

### Port Allocation

| Port | Protocol | Purpose |
|------|----------|---------|
| 9000 | HTTP/1.1 + WebSocket | REST API (stream list, cert hash, health) + WS fallback at `/ws` |
| 9001 | HTTP/3 (QUIC) | WebTransport sessions |
| 5173 | HTTP/1.1 | Vite dev server (client) |
| 8554 | RTSP | MediaMTX camera streams (Docker) |

All servers bind to `0.0.0.0` for LAN accessibility.

## Consequences

- All existing tests (41) continue to pass — the H.264 parser and grid layout tests are transport-agnostic
- The binary video frame protocol (12-byte header) is unchanged; only the delivery mechanism varies by transport
- The client's `StreamPipeline` accepts a `StreamReceiver` interface, making it fully transport-agnostic
- The `StreamManager` uses a `BridgeClient` discriminated union (`WTClient | WSClient`) and transport-agnostic `VideoSubscription` callbacks — RTSP distribution logic is shared
- Server startup takes ~100ms longer due to TLS certificate generation
- Both `ws` and `@fails-components/webtransport` are runtime dependencies of the bridge server
- Safari 17+ and Firefox users get functional video streaming via WebSocket (TCP), with the caveat of head-of-line blocking under packet loss
- Chrome/Edge users automatically get the superior WebTransport (QUIC) path with no configuration
