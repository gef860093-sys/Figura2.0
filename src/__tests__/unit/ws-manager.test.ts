import { createWebSocketManager } from '../../ws-manager';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import * as fc from 'fast-check';

describe('WebSocket Manager', () => {
  let httpServer: any;
  let logger: any;

  beforeEach(() => {
    httpServer = createServer();
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  afterEach(() => {
    httpServer.close();
  });

  it('should track connection count', () => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 30000,
      pongTimeoutMs: 10000,
      maxConnections: 10000,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 100,
    }, logger);

    expect(manager.connectionCount).toBe(0);
  });

  // Property 3: WebSocket connection cleanup
  it('should remove connection from map on close', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 30000,
      pongTimeoutMs: 10000,
      maxConnections: 10000,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 100,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      const ws = new WebSocket(`ws://localhost:${port}`);

      ws.on('open', () => {
        const initialCount = manager.connectionCount;
        expect(initialCount).toBe(1);

        ws.close();
        setTimeout(() => {
          expect(manager.connectionCount).toBe(0);
          done();
        }, 100);
      });
    });
  });

  // Property 7: Connection limit enforced
  it('should reject connections when limit reached', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 30000,
      pongTimeoutMs: 10000,
      maxConnections: 1,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 100,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      const ws1 = new WebSocket(`ws://localhost:${port}`);

      ws1.on('open', () => {
        const ws2 = new WebSocket(`ws://localhost:${port}`);

        ws2.on('close', (code) => {
          expect(code).toBe(1013);
          done();
        });
      });
    });
  });

  // Property 8: Oversized messages cause 1009 termination
  it('should close connection with 1009 for oversized messages', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 30000,
      pongTimeoutMs: 10000,
      maxConnections: 10000,
      maxMessageBytes: 100,
      maxMsgRatePerMin: 100,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      const ws = new WebSocket(`ws://localhost:${port}`);

      ws.on('open', () => {
        const largeMessage = Buffer.alloc(200);
        ws.send(largeMessage);

        ws.on('close', (code) => {
          expect(code).toBe(1009);
          done();
        });
      });
    });
  });

  // Property 9: Message rate enforcement
  it('should close connection with 1008 for rate exceeded', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 30000,
      pongTimeoutMs: 10000,
      maxConnections: 10000,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 5,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      const ws = new WebSocket(`ws://localhost:${port}`);

      ws.on('open', () => {
        for (let i = 0; i < 10; i++) {
          ws.send('test');
        }

        ws.on('close', (code) => {
          expect(code).toBe(1008);
          done();
        });
      });
    });
  });

  // Property 5: Ping sent to all connections
  it('should send ping to all connections', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 100,
      pongTimeoutMs: 10000,
      maxConnections: 10000,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 100,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      const ws = new WebSocket(`ws://localhost:${port}`);
      let pingReceived = false;

      ws.on('open', () => {
        ws.on('ping', () => {
          pingReceived = true;
          expect(pingReceived).toBe(true);
          ws.close();
          manager.destroy();
          done();
        });
      });
    });
  });

  // Property 6: Unresponsive connections are terminated
  it('should terminate connections that do not respond to ping', (done) => {
    const manager = createWebSocketManager(httpServer, {
      pingIntervalMs: 100,
      pongTimeoutMs: 50,
      maxConnections: 10000,
      maxMessageBytes: 1048576,
      maxMsgRatePerMin: 100,
    }, logger);

    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      // Use a raw WebSocket but intercept pong sending to suppress it
      const ws = new WebSocket(`ws://localhost:${port}`);

      ws.on('open', () => {
        // Pause the underlying socket so pong frames can't be sent back
        (ws as any)._socket.pause();

        // After pingInterval + pongTimeout, the server should have terminated the connection
        setTimeout(() => {
          expect(manager.connectionCount).toBe(0);
          manager.destroy();
          ws.terminate();
          done();
        }, 300);
      });
    });
  });
});
