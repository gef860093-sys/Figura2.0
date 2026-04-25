import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { ManagedConnection, Logger } from './types';

export interface WebSocketManagerConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  maxConnections: number;
  maxMessageBytes: number;
  maxMsgRatePerMin: number;
}

export interface WebSocketManager {
  readonly connectionCount: number;
  closeAll(code: number): void;
  destroy(): void;
}

// Expected close codes that are not considered unexpected
const EXPECTED_CLOSE_CODES = new Set([1000, 1001, 1008, 1009, 1013]);

export function createWebSocketManager(
  httpServer: HttpServer,
  config: WebSocketManagerConfig,
  logger: Logger
): WebSocketManager {
  const connections = new Map<string, ManagedConnection>();
  const pongTimeouts = new Map<string, NodeJS.Timeout>();
  let heartbeatInterval: NodeJS.Timeout | null = null;

  const wss = new WebSocketServer({ server: httpServer });

  function cleanupConnection(connId: string): void {
    const conn = connections.get(connId);
    if (!conn) return;

    // Clear pong timeout
    const pongTimeout = pongTimeouts.get(connId);
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeouts.delete(connId);
    }

    // Remove from map immediately
    connections.delete(connId);

    // Null out references within 5s (safety guarantee per Requirement 1.4)
    setTimeout(() => {
      (conn as any).socket = null;
      (conn as any).id = null;
    }, 5000);
  }

  function startHeartbeat(): void {
    if (heartbeatInterval) return;

    heartbeatInterval = setInterval(() => {
      connections.forEach((conn, connId) => {
        if (!conn.isAlive) {
          // No pong received since last ping — terminate
          logger.debug('Terminating unresponsive connection (no pong)', { connId });
          if (conn.socket.readyState === WebSocket.OPEN) {
            conn.socket.terminate();
          }
          cleanupConnection(connId);
          return;
        }

        // Mark as not alive until pong arrives
        conn.isAlive = false;
        conn.socket.ping();

        // Set pong timeout: terminate if no pong within pongTimeoutMs
        const pongTimeout = setTimeout(() => {
          logger.debug('Pong timeout — terminating connection', { connId });
          if (conn.socket.readyState === WebSocket.OPEN) {
            conn.socket.terminate();
          }
          cleanupConnection(connId);
        }, config.pongTimeoutMs);

        pongTimeouts.set(connId, pongTimeout);
      });
    }, config.pingIntervalMs);
  }

  wss.on('connection', (socket: WebSocket) => {
    // Check connection limit (Requirement 2.4, 2.5)
    if (connections.size >= config.maxConnections) {
      logger.warn('Connection limit reached, rejecting new connection', {
        limit: config.maxConnections,
        current: connections.size,
      });
      socket.close(1013, 'Try again later');
      return;
    }

    const connId = randomUUID();
    const now = Date.now();
    const conn: ManagedConnection = {
      id: connId,
      socket,
      isAlive: true,
      messageCount: 0,
      messageWindowStart: now,
      createdAt: now,
    };

    connections.set(connId, conn);
    logger.debug('WebSocket connection opened', { connId, totalConnections: connections.size });

    // Start heartbeat on first connection
    if (connections.size === 1) {
      startHeartbeat();
    }

    // On pong: mark alive, clear pong timeout (Requirement 2.1, 2.2)
    socket.on('pong', () => {
      conn.isAlive = true;
      const pongTimeout = pongTimeouts.get(connId);
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeouts.delete(connId);
      }
    });

    // On message: validate size and rate (Requirements 2.6, 2.7)
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const size = Buffer.isBuffer(data)
        ? data.length
        : data instanceof ArrayBuffer
          ? data.byteLength
          : (data as Buffer[]).reduce((acc, b) => acc + b.length, 0);

      // Check message size (Requirement 2.6)
      if (size > config.maxMessageBytes) {
        logger.warn('Message too large, closing connection', { connId, size, max: config.maxMessageBytes });
        socket.close(1009, 'Message too big');
        cleanupConnection(connId);
        return;
      }

      // Check message rate (Requirement 2.7)
      const now = Date.now();
      if (now - conn.messageWindowStart > 60_000) {
        conn.messageCount = 0;
        conn.messageWindowStart = now;
      }

      conn.messageCount++;
      if (conn.messageCount > config.maxMsgRatePerMin) {
        logger.warn('Message rate exceeded, closing connection', {
          connId,
          messageCount: conn.messageCount,
          limit: config.maxMsgRatePerMin,
        });
        socket.close(1008, 'Policy violation');
        cleanupConnection(connId);
        return;
      }
    });

    // On close: log unexpected closes, clean up (Requirements 2.3, 1.4)
    socket.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();

      if (!EXPECTED_CLOSE_CODES.has(code)) {
        logger.warn('WebSocket connection closed unexpectedly', { connId, code, reason: reasonStr });
      } else {
        logger.debug('WebSocket connection closed', { connId, code, reason: reasonStr });
      }

      cleanupConnection(connId);
    });

    socket.on('error', (err: Error) => {
      logger.error('WebSocket error', { connId, error: err.message });
      cleanupConnection(connId);
    });
  });

  return {
    get connectionCount(): number {
      return connections.size;
    },

    closeAll(code: number): void {
      connections.forEach((conn, connId) => {
        if (conn.socket.readyState === WebSocket.OPEN) {
          conn.socket.close(code, 'Server shutting down');
        }
      });
    },

    destroy(): void {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      // Clear all pong timeouts
      pongTimeouts.forEach((timeout) => clearTimeout(timeout));
      pongTimeouts.clear();
    },
  };
}
