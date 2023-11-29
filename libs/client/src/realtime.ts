import { getConfig, getRestApiUrl } from './config';
import { dispatchRequest } from './request';
import { ApiError } from './response';
import { isBrowser } from './runtime';
import { isReact, throttle } from './utils';

/**
 * A connection object that allows you to `send` request payloads to a
 * realtime endpoint.
 */
export interface RealtimeConnection<Input> {
  send(input: Input): void;

  close(): void;
}

type ResultWithRequestId = {
  request_id: string;
};

/**
 * Options for connecting to the realtime endpoint.
 */
export interface RealtimeConnectionHandler<Output> {
  /**
   * The connection key. This is used to reuse the same connection
   * across multiple calls to `connect`. This is particularly useful in
   * contexts where the connection is established as part of a component
   * lifecycle (e.g. React) and the component is re-rendered multiple times.
   */
  connectionKey?: string;

  /**
   * If `true`, the connection will only be established on the client side.
   * This is useful for frameworks that reuse code for both server-side
   * rendering and client-side rendering (e.g. Next.js).
   *
   * This is set to `true` by default when running on React in the server.
   * Otherwise, it is set to `false`.
   *
   * Note that more SSR frameworks might be automatically detected
   * in the future. In the meantime, you can set this to `true` when needed.
   */
  clientOnly?: boolean;

  /**
   * The throtle duration in milliseconds. This is used to throtle the
   * calls to the `send` function. Realtime apps usually react to user
   * input, which can be very frequesnt (e.g. fast typing or mouse/drag movements).
   *
   * The default value is `64` milliseconds.
   */
  throttleInterval?: number;

  /**
   * Callback function that is called when a result is received.
   * @param result - The result of the request.
   */
  onResult(result: Output & ResultWithRequestId): void;

  /**
   * Callback function that is called when an error occurs.
   * @param error - The error that occurred.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?(error: ApiError<any>): void;
}

export interface RealtimeClient {
  /**
   * Connect to the realtime endpoint. The default implementation uses
   * WebSockets to connect to fal function endpoints that support WSS.
   *
   * @param app the app alias or identifier.
   * @param handler the connection handler.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect<Input = any, Output = any>(
    app: string,
    handler: RealtimeConnectionHandler<Output>
  ): RealtimeConnection<Input>;
}

function buildRealtimeUrl(app: string): string {
  const { host } = getConfig();
  return `wss://${app}.${host}/ws`;
}

const TOKEN_EXPIRATION_SECONDS = 120;

/**
 * Get a token to connect to the realtime endpoint.
 */
async function getToken(app: string): Promise<string> {
  const [_, ...appAlias] = app.split('-');
  const token: string | object = await dispatchRequest<any, string>(
    'POST',
    `https://${getRestApiUrl()}/tokens/`,
    {
      allowed_apps: [appAlias.join('-')],
      token_expiration: 120,
    }
  );
  // keep this in case the response was wrapped (old versions of the proxy do that)
  // should be safe to remove in the future
  if (typeof token !== 'string' && token['detail']) {
    return token['detail'];
  }
  return token;
}

/**
 * See https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
 */
const WebSocketErrorCodes = {
  NORMAL_CLOSURE: 1000,
  GOING_AWAY: 1001,
};

const connectionManager = (() => {
  const connections = new Map<string, WebSocket>();
  const tokens = new Map<string, string>();
  const isAuthInProgress = new Map<string, true>();

  return {
    token(app: string) {
      return tokens.get(app);
    },
    expireToken(app: string) {
      tokens.delete(app);
    },
    async refreshToken(app: string) {
      const token = await getToken(app);
      tokens.set(app, token);
      // Very simple token expiration mechanism.
      // We should make it more robust in the future.
      setTimeout(() => {
        tokens.delete(app);
      }, TOKEN_EXPIRATION_SECONDS * 0.9 * 1000);
      return token;
    },
    has(connectionKey: string): boolean {
      return connections.has(connectionKey);
    },
    get(connectionKey: string): WebSocket | undefined {
      return connections.get(connectionKey);
    },
    set(connectionKey: string, ws: WebSocket) {
      connections.set(connectionKey, ws);
    },
    remove(connectionKey: string) {
      connections.delete(connectionKey);
    },
    isAuthInProgress(app: string) {
      return isAuthInProgress.has(app);
    },
    setAuthInProgress(app: string, inProgress: boolean) {
      if (inProgress) {
        isAuthInProgress.set(app, true);
      } else {
        isAuthInProgress.delete(app);
      }
    },
  };
})();

async function getConnection(app: string, key: string): Promise<WebSocket> {
  if (connectionManager.isAuthInProgress(app)) {
    throw new Error('Authentication in progress');
  }
  const url = buildRealtimeUrl(app);

  if (connectionManager.has(key)) {
    return connectionManager.get(key) as WebSocket;
  }
  let token = connectionManager.token(app);
  if (!token) {
    connectionManager.setAuthInProgress(app, true);
    token = await connectionManager.refreshToken(app);
    connectionManager.setAuthInProgress(app, false);
  }
  const ws = new WebSocket(`${url}?fal_jwt_token=${token}`);
  connectionManager.set(key, ws);
  return ws;
}

const noop = () => {
  /* No-op */
};

/**
 * A no-op connection that does not send any message.
 * Useful on the frameworks that reuse code for both ssr and csr (e.g. Next)
 * so the call when doing ssr has no side-effects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NoOpConnection: RealtimeConnection<any> = {
  send: noop,
  close: noop,
};

/**
 * The default implementation of the realtime client.
 */
export const realtimeImpl: RealtimeClient = {
  connect<Input, Output>(
    app: string,
    handler: RealtimeConnectionHandler<Output>
  ): RealtimeConnection<Input> {
    const {
      // if running on React in the server, set clientOnly to true by default
      clientOnly = isReact() && !isBrowser(),
      connectionKey = crypto.randomUUID(),
      throttleInterval = 64,
      onError = noop,
      onResult,
    } = handler;
    if (clientOnly && typeof window === 'undefined') {
      return NoOpConnection;
    }

    let pendingMessage: Input | undefined = undefined;

    let reconnecting = false;
    let ws: WebSocket | null = null;
    const _send = (input: Input) => {
      const requestId = crypto.randomUUID();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            request_id: requestId,
            ...input,
          })
        );
      } else {
        pendingMessage = input;
        if (!reconnecting) {
          reconnecting = true;
          reconnect();
        }
      }
    };
    const send =
      throttleInterval > 0 ? throttle(_send, throttleInterval) : _send;

    const reconnect = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return;
      }
      if (connectionManager.isAuthInProgress(app)) {
        return;
      }
      getConnection(app, connectionKey)
        .then((connection) => {
          ws = connection;
          ws.onopen = () => {
            reconnecting = false;
            if (pendingMessage) {
              send(pendingMessage);
              pendingMessage = undefined;
            }
          };
          ws.onclose = (event) => {
            connectionManager.remove(connectionKey);
            if (event.code !== WebSocketErrorCodes.NORMAL_CLOSURE) {
              onError(
                new ApiError({
                  message: `Error closing the connection: ${event.reason}`,
                  status: event.code,
                })
              );
            }
            ws = null;
          };
          ws.onerror = (event) => {
            // TODO handle errors once server specify them
            // if error 401, refresh token and retry
            // if error 403, refresh token and retry
            connectionManager.expireToken(app);
            connectionManager.remove(connectionKey);
            ws = null;
            // if any of those are failed again, call onError
            onError(new ApiError({ message: 'Unknown error', status: 500 }));
          };
          ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            // Drop messages that are not related to the actual result.
            // In the future, we might want to handle other types of messages.
            // TODO: specify the fal ws protocol format
            if (data.status !== 'error' && data.type !== 'x-fal-message') {
              onResult(data);
            }
          };
        })
        .catch((error) => {
          onError(
            new ApiError({ message: 'Error opening connection', status: 500 })
          );
        });
    };

    return {
      send,
      close() {
        if (ws && ws.readyState === WebSocket.CLOSED) {
          ws.close(
            WebSocketErrorCodes.GOING_AWAY,
            'Client manually closed the connection.'
          );
        }
      },
    };
  },
};
