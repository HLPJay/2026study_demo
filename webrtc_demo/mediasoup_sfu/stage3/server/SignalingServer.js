const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const config    = require('./config');
const Peer      = require('./Peer');
const Room      = require('./Room');
class SignalingServer {
  constructor(rooms, workerManager, Room) {
    this._rooms         = rooms;
    this._workerManager = workerManager;
    this._Room          = Room;  // ← 不要写 null
  }

  start() {
    let server;
    if (fs.existsSync(config.signaling.cert)) {
      server = https.createServer({
        cert: fs.readFileSync(config.signaling.cert),
        key:  fs.readFileSync(config.signaling.key),
      });
      console.log('[Signaling] HTTPS 模式');
    } else {
      server = http.createServer();
      console.log('[Signaling] HTTP 模式');
    }

    const wss = new WebSocket.Server({ server });

    wss.on('connection', (socket, req) => {
      console.log('[Signaling] 新连接 ' + req.socket.remoteAddress);
      socket._peer   = null;
      socket._roomId = null;

      socket.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch(e) { return; }
        const { requestId } = msg;
        try {
          await this._handle(socket, msg, requestId);
        } catch(err) {
          console.error('[Signaling] 错误:', err.message);
          this._reply(socket, requestId, { type:'error', message:err.message });
        }
      });

      socket.on('close', () => this._onClose(socket));
      socket.on('error', (e) => console.error('[Signaling] socket error:', e.message));
    });

    server.listen(config.signaling.port, '0.0.0.0', () => {
      console.log('[Signaling] 启动成功，端口 ' + config.signaling.port);
    });
  }

  async _handle(socket, msg, requestId) {
    const { type } = msg;
    console.log('[Signaling] <- ' + type + ' peer=' + (socket._peer ? socket._peer.id : '未知'));
    switch(type) {
      case 'getRouterRtpCapabilities': return this._onGetCaps(socket, msg, requestId);
      case 'join':                     return this._onJoin(socket, msg, requestId);
      case 'createTransport':          return this._onCreateTransport(socket, msg, requestId);
      case 'connectTransport':         return this._onConnectTransport(socket, msg, requestId);
      case 'produce':                  return this._onProduce(socket, msg, requestId);
      case 'consume':                  return this._onConsume(socket, msg, requestId);
      case 'resumeConsumer':           return this._onResumeConsumer(socket, msg, requestId);
      case 'setPreferredLayers':       return this._onSetPreferredLayers(socket, msg, requestId);
      case 'getStats':                 return this._onGetStats(socket, msg, requestId);
      default: console.warn('[Signaling] 未知类型: ' + type);
    }
  }

  async _onGetCaps(socket, msg, requestId) {
    const { roomId } = msg;
    let room = this._rooms.get(roomId);
    if (!room) {
      const worker = this._workerManager.getWorker();
      room = await this._Room.create(roomId, worker);
      this._rooms.set(roomId, room);
      console.log('[Signaling] 预创建房间 ' + roomId);
    }
    this._reply(socket, requestId, {
      type:            'routerRtpCapabilities',
      rtpCapabilities: room.router.rtpCapabilities,
    });
  }

  async _onJoin(socket, msg, requestId) {
    const { roomId, peerId, rtpCapabilities } = msg;
    let room = this._rooms.get(roomId);
    if (!room) {
      const worker = this._workerManager.getWorker();
      room = await this._Room.create(roomId, worker);
      this._rooms.set(roomId, room);
    }
    const peer            = new Peer(peerId, socket);
    peer._rtpCapabilities = rtpCapabilities;
    room.addPeer(peer);
    socket._peer   = peer;
    socket._roomId = roomId;

    const existingPeers = room.getPeers()
      .filter(p => p.id !== peerId)
      .map(p => p.toJSON());

    this._reply(socket, requestId, { type:'joined', roomId, peerId, existingPeers });
    room.broadcast(peerId, { type:'peerJoined', peerId });
    console.log('[Signaling] peer=' + peerId + ' 加入 ' + roomId + ' 共' + room.getPeers().length + '人');
  }

  async _onCreateTransport(socket, msg, requestId) {
    const { direction } = msg;
    const room      = this._getRoom(socket);
    const peer      = socket._peer;
    const opts      = await room.createWebRtcTransport(peer);
    const transport = peer.getTransport(opts.id);
    transport.appData = { direction };
    this._reply(socket, requestId, {
      type:'transportCreated', direction, transportOptions:opts
    });
  }

  async _onConnectTransport(socket, msg, requestId) {
    const { transportId, dtlsParameters } = msg;
    await this._getRoom(socket).connectTransport(socket._peer, transportId, dtlsParameters);
    this._reply(socket, requestId, { type:'transportConnected', transportId });
  }

  async _onProduce(socket, msg, requestId) {
    const { transportId, kind, rtpParameters, appData } = msg;
    const producerId = await this._getRoom(socket).produce(
      socket._peer, transportId, kind, rtpParameters, appData
    );
    this._reply(socket, requestId, { type:'produced', id:producerId });
  }

  async _onConsume(socket, msg, requestId) {
    const { producerPeerId, producerId } = msg;
    const room         = this._getRoom(socket);
    const producerPeer = room.getPeer(producerPeerId);
    if (!producerPeer) throw new Error('Peer ' + producerPeerId + ' 不存在');
    //这里客户端核心实际上是根据data.type进行判断的
    const data = await room.consume(socket._peer, producerPeer, producerId);
    if (!data) {
      this._reply(socket, requestId, { type:'consumeFailed', producerId });
      return;
    }
    this._reply(socket, requestId, { type:'consumed', ...data });
  }

  async _onResumeConsumer(socket, msg, requestId) {
    const { consumerId } = msg;
    const consumer = socket._peer.getConsumer(consumerId);
    if (!consumer) throw new Error('Consumer ' + consumerId + ' 不存在');
    await consumer.resume();
    this._reply(socket, requestId, { type:'consumerResumed', consumerId });
  }

  async _onSetPreferredLayers(socket, msg, requestId) {
    const { consumerId, spatialLayer, temporalLayer } = msg;
    const consumer = socket._peer.getConsumer(consumerId);
    if (!consumer) throw new Error('Consumer ' + consumerId + ' 不存在');
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    this._reply(socket, requestId, { type:'preferredLayersSet', consumerId });
  }

  async _onGetStats(socket, msg, requestId) {
    const { producerId, consumerId } = msg;
    const peer = socket._peer;
    let stats = null;
    if (producerId) {
      const p = peer.getProducer(producerId);
      if (p) stats = await p.getStats();
    } else if (consumerId) {
      const c = peer.getConsumer(consumerId);
      if (c) stats = await c.getStats();
    }
    this._reply(socket, requestId, { type:'stats', stats });
  }

  _onClose(socket) {
    const peer   = socket._peer;
    const roomId = socket._roomId;
    if (!peer || !roomId) return;
    const room = this._rooms.get(roomId);
    if (!room) return;
    room.removePeer(peer.id);
    room.broadcast(peer.id, { type:'peerLeft', peerId:peer.id });
    if (room.isEmpty) {
      room.close();
      this._rooms.delete(roomId);
      console.log('[Signaling] 房间 ' + roomId + ' 已删除');
    }
    console.log('[Signaling] peer=' + peer.id + ' 断开');
  }

  _getRoom(socket) {
    const room = this._rooms.get(socket._roomId);
    if (!room) throw new Error('房间不存在');
    return room;
  }

  _reply(socket, requestId, data) {
    if (socket.readyState === WebSocket.OPEN) {
      if (requestId !== undefined) data.requestId = requestId;
      socket.send(JSON.stringify(data));
      console.log('[Signaling] -> ' + data.type + ' reqId=' + requestId);
    }
  }
}

module.exports = SignalingServer;