/**
 * Type declarations for @fails-components/webtransport.
 *
 * Minimal type surface needed by the bridge server. The library ships
 * JSDoc-typed JavaScript with .d.ts files, but module resolution with
 * bundler mode doesn't always find them. This declaration unblocks
 * TypeScript compilation.
 */

declare module '@fails-components/webtransport' {
  export interface HttpServerInit {
    port: number;
    host: string;
    secret: string;
    cert: string;
    privKey: string;
  }

  export class HttpServer {
    constructor(args: HttpServerInit);
    ready: Promise<unknown>;
    closed: Promise<unknown>;
    startServer(): void;
    stopServer(): void;
    sessionStream(
      path: string,
      args?: { noAutoPaths?: boolean }
    ): ReadableStream<WebTransportSession>;
  }

  export class Http3Server extends HttpServer {}
  export class Http2Server extends HttpServer {}

  export interface WebTransportSession {
    ready: Promise<void>;
    closed: Promise<{ closeCode: number; reason: string }>;
    incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
    incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
    createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
    createBidirectionalStream(): Promise<WebTransportBidirectionalStream>;
    close(info?: { closeCode: number; reason: string }): void;
  }

  export interface WebTransportBidirectionalStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }
}
