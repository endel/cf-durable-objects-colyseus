import { EventEmitter } from "node:events";
import {
  matchMaker, Protocol, Transport, ClientState, CloseCode,
  connectClientToRoom, createAuthContext, enqueueClientRaw, getMessageBytes, debugAndPrintError,
  type Client, type ClientPrivate, type ISendOptions, type Router,
} from "@colyseus/core";

/**
 * Serves Colyseus from a Durable Object's `fetch()`: nothing listens on a
 * port, the object hands every request to {@link DurableObjectTransport.fetch}.
 */
export class DurableObjectTransport extends Transport {
  private router?: Router;

  /** Cumulative traffic counters, for benchmarks. */
  public static stats = { messagesIn: 0, messagesOut: 0, bytesOut: 0 };

  public bindRouter(router: Router) { this.router = router; }

  public listen(_port?: number | string, _hostname?: string, _backlog?: number, listeningListener?: Function) {
    listeningListener?.();
    return this;
  }

  public shutdown() {}
  public simulateLatency() {}

  public async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.upgrade(request);
    }

    const cors = {
      ...matchMaker.controller.DEFAULT_CORS_HEADERS,
      ...matchMaker.controller.getCorsHeaders(request.headers),
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors as any });
    }

    const response = await this.router!.handler(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) {
      if (!headers.has(key)) { headers.set(key, String(value)); }
    }
    return new Response(response.body, { status: response.status, headers });
  }

  private upgrade(request: Request): Response {
    const url = new URL(request.url);
    const [clientSide, ws] = Object.values(new WebSocketPair());

    // accept(), not ctx.acceptWebSocket(): hibernation would evict the rooms held in memory
    ws.accept();

    const ref = new WebSocketRef(ws);
    const sessionId = url.searchParams.get("sessionId");
    const roomId = url.pathname.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/)?.[1];

    if (!sessionId && !roomId) {
      // ping-pong utility, used by the SDK's latency measurement
      const timeout = setTimeout(() => ws.close(CloseCode.NORMAL_CLOSURE), 1000);
      ref.on("message", () => ws.send(new Uint8Array([Protocol.PING])));
      ref.on("close", () => clearTimeout(timeout));

    } else {
      const client = new DurableObjectClient(sessionId!, ref);
      const reconnectionToken = url.searchParams.get("reconnectionToken") ?? undefined;

      connectClientToRoom(matchMaker.getLocalRoomById(roomId!), client, createAuthContext({
        headers: request.headers,
        token: url.searchParams.get("_authToken"),
        remoteAddress: request.headers.get("cf-connecting-ip") ?? undefined,
      }), {
        reconnectionToken,
        skipHandshake: url.searchParams.has("skipHandshake"),

      }).catch((e: any) => {
        debugAndPrintError(e);
        client.error(e.code, e.message);
        ws.close(reconnectionToken ? CloseCode.FAILED_TO_RECONNECT : CloseCode.WITH_ERROR);
      });
    }

    return new Response(null, { status: 101, webSocket: clientSide });
  }
}

/** Re-emits a workerd WebSocket's events the way Room expects them from `client.ref`. */
class WebSocketRef extends EventEmitter {
  constructor(public ws: WebSocket) {
    super();
    ws.binaryType = "arraybuffer"; // recent compatibility dates default to Blob
    ws.addEventListener("message", (event) => {
      // text frames are not part of the protocol
      DurableObjectTransport.stats.messagesIn++;
      if (typeof event.data !== "string") { this.emit("message", Buffer.from(event.data as ArrayBuffer)); }
    });
    ws.addEventListener("close", (event) => this.emit("close", event.code));
    ws.addEventListener("error", () => this.emit("close", CloseCode.WITH_ERROR));
  }
}

class DurableObjectClient implements Client, ClientPrivate {
  "~messages": any;

  public state: ClientState = ClientState.JOINING;
  public reconnectionToken!: string;
  public _enqueuedMessages: any[] = [];
  public _joinedAt!: number;

  constructor(public sessionId: string, public ref: WebSocketRef) {}

  get readyState() { return this.ref.ws.readyState; }

  public send(type: any, message?: any, options?: ISendOptions) {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA, type, message), options);
  }

  public sendBytes(type: string | number, bytes: Uint8Array, options?: ISendOptions) {
    this.enqueueRaw(getMessageBytes.raw(Protocol.ROOM_DATA_BYTES, type, undefined, bytes), options);
  }

  public enqueueRaw(data: Uint8Array, options?: ISendOptions) {
    enqueueClientRaw(this, data, options);
  }

  public raw(data: Uint8Array) {
    if (this.ref.ws.readyState !== WebSocket.OPEN) { return; }
    DurableObjectTransport.stats.messagesOut++;
    DurableObjectTransport.stats.bytesOut += data.byteLength;
    this.ref.ws.send(data);
  }

  public error(code: number, message: string = "") {
    this.raw(getMessageBytes[Protocol.ERROR](code, message));
  }

  public leave(code?: number, data?: string) {
    this.ref.ws.close(code, data);
    // workerd only fires "close" once the peer answers the close frame
    this.ref.emit("close", code);
  }

  public close(code?: number, data?: string) { this.leave(code, data); }
}
