# Research Findings: Browser Video Performance for VMS

## Key Findings Summary

### What We Know Works

1. **WebCodecs + WebGPU is the correct architecture** for multi-stream browser video
2. **Zero-copy GPU rendering is real**: `importExternalTexture()` wraps the hardware decoder's NV12 texture directly — no pixel copies
3. **Both browser and native hit the same GPU hardware decoders** (NVDEC, Quick Sync, VCN). The decode itself takes 1-3ms regardless of path
4. **Browser overhead is measurable but not fatal**: ~2-3ms extra per frame from Chrome's GPU process IPC
5. **Practical limit**: 8-16 concurrent 4K@30fps streams in browser vs 16-32 native (single GPU)
6. **Adaptive quality tiers are essential**: Decode at display resolution, not source resolution. A 64-tile grid on a 4K monitor gives ~480×270 pixels per tile

### Critical Performance Numbers

| Metric | Value | Source |
|--------|-------|--------|
| H.264 HW decode latency | 1-3ms per frame | Measured across all paths |
| Browser IPC overhead | 100-1000μs per frame | Chromium GPU process |
| 4K YUV420 frame copy cost | 6.6ms (hot) / 17ms (cold) | Paul Adenot, W3C Workshop |
| V8 GC pause (major) | 5-50ms | Chrome profiling |
| 30fps frame budget | 33.3ms | Physics |
| importExternalTexture | 0ms (zero-copy, GPU-backed) | Chrome implementation |
| Chrome PeerConnection limit | 500 per page | Chrome hard limit |
| Per-stream memory (browser) | ~35-60 MB | Estimated |
| Per-stream memory (native) | ~31-52 MB | Estimated |

### Why WebCodecs Over WebRTC

- **HEVC support**: WebCodecs since Chrome 107 (2022); WebRTC only Chrome 136+ (mid-2025)
- **No jitter buffer**: WebRTC adds 20-80ms automatic buffering; WebCodecs is immediate
- **Frame-level control**: Full access to VideoFrame objects for custom processing
- **Explicit backpressure**: `decodeQueueSize` monitoring vs WebRTC's opaque adaptation
- **Hardware acceleration control**: `prefer-hardware` config option
- **Resource management**: Explicit `frame.close()` vs WebRTC's GC-dependent cleanup

### Why WebGPU Over Canvas2D/WebGL

- **`importExternalTexture`**: Zero-copy path from hardware decoder to GPU render
- **Compute shaders**: Available for video processing (deinterlacing, scaling)
- **Render bundles**: Batch draw calls for multiple stream tiles
- **Better memory model**: Explicit buffer/texture lifecycle
- **Universal support**: All major browsers since late 2025 (Chrome 113+, Firefox 141+, Safari 26+)

### Browser Limitations to Work Around

1. **Single GPU process**: All tabs share one GPU process; becomes bottleneck at scale
2. **V8 GC pauses**: 5-50ms unpredictable pauses affect real-time rendering
3. **No multi-GPU**: Browsers don't expose GPU selection for decode vs render
4. **importExternalTexture in Firefox**: Not yet implemented (Chrome/Safari only for zero-copy)
5. **Tab memory limits**: Browser may kill tabs exceeding memory thresholds

### Mitigation Strategies

- **VideoFrame.close() religiously**: Every frame must be closed or GPU memory leaks
- **Backpressure via decodeQueueSize**: Drop non-keyframes when queue depth > 3
- **requestAnimationFrame render loop**: Don't render more than display refresh rate
- **Web Workers for parsing**: Offload H.264 demuxing to workers (not decode — decoders must be on main thread or dedicated worker)
- **Visibility API**: Pause decode when tab is hidden

## Codec Compatibility

| Codec | WebCodecs Config String | Hardware Decode | Notes |
|-------|------------------------|-----------------|-------|
| H.264 Baseline | `avc1.42001e` | Universal | Most compatible |
| H.264 Main | `avc1.4d001f` | Universal | Good balance |
| H.264 High | `avc1.64001f` | Universal | Best quality/size |
| H.264 High 4K | `avc1.640033` | Common | Level 5.1 for 4K |

## Commercial VMS Reference Points

- **Milestone XProtect**: Achieves 100+ FHD streams via "direct streaming" (H.264 passthrough to browser, no transcoding)
- **Genetec SaaS**: Uses WebRTC from Cloudlink appliances
- **Cloud-native VMS** (Verkada, Eagle Eye): HLS/DASH with 2-30s latency
- **Industry consensus**: Web clients for 80% of use cases; desktop for control rooms

## RTSP to Browser Bridging

The recommended approach for this prototype:
1. **MediaMTX** as RTSP server (zero-dependency, Docker-ready)
2. **FFmpeg** to loop test videos as RTSP sources
3. **Custom Node.js bridge** that reads RTSP, extracts H.264 NALUs, sends over WebSocket
4. **Browser WebCodecs** decodes the raw H.264 NALUs

This avoids WebRTC signaling complexity and gives us direct control over the entire pipeline.
