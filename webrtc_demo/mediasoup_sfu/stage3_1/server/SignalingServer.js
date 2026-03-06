// SignalingServer.js - 含 ICE Restart、异常处理
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
      console.log('[Signaling] 启动 port=' + config.signaling.port);
    });
  }

  async _handle(socket, msg, requestId) {
    const { type } = msg;
    console.log('[Signaling] <- ' + type + ' peer=' + (socket._peer ? socket._peer.id : '未知'));
    switch(type) {
      case 'getRouterRtpCapabilities': return this._onGetCaps(socket, msg, requestId);
      case 'rejoin':                    return this._onRejoin(socket, msg, requestId);
      case 'join':                     return this._onJoin(socket, msg, requestId);
      case 'createTransport':          return this._onCreateTransport(socket, msg, requestId);
      case 'connectTransport':         return this._onConnectTransport(socket, msg, requestId);
      case 'restartIce':               return this._onRestartIce(socket, msg, requestId);
      case 'produce':                  return this._onProduce(socket, msg, requestId);
      case 'consume':                  return this._onConsume(socket, msg, requestId);
      case 'resumeConsumer':           return this._onResumeConsumer(socket, msg, requestId);
      case 'pauseProducer':            return this._onPauseProducer(socket, msg, requestId);
      case 'resumeProducer':           return this._onResumeProducer(socket, msg, requestId);
      case 'setPreferredLayers':       return this._onSetPreferredLayers(socket, msg, requestId);
      case 'getStats':                 return this._onGetStats(socket, msg, requestId);
      default: console.warn('[Signaling] 未知类型: ' + type);
    }
  }

  // ── 获取 Router RTP 能力 ──
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

  // ── 重连恢复会话 ──
  async _onRejoin(socket, msg, requestId) {
    const { roomId, peerId, rtpCapabilities } = msg;
    const room = this._rooms.get(roomId);

    // 房间不存在 or Peer 不存在 → fallback 到普通 join
    // 注意：回复类型用 'rejoined'（客户端 wsRequest 等的是这个类型）
    // 在 _onJoin 里通过 msg._replyType 控制回复类型
    if (!room || !room.getPeer(peerId)) {
      console.log('[Signaling] rejoin fallback to join peer=' + peerId);
      msg._replyType = 'rejoined';  // 让 _onJoin 回 rejoined
      return this._onJoin(socket, msg, requestId);
    }

    const peer = room.getPeer(peerId);
    console.log('[Signaling] rejoin 复用 peer=' + peerId);

    // 更新 socket 绑定（旧 socket 已断，新 socket 接管）
    peer.socket = socket;
    socket._peer   = peer;
    socket._roomId = roomId;
    peer._rtpCapabilities = rtpCapabilities;

    // ★ 先收集信息（关 Transport 之前，Consumer 还存活）
    const myProducers = [...peer._producers.values()].map(p => ({
      id:     p.id,
      kind:   p.kind,
      paused: p.paused,
    }));

    // Consumer 需要带上 peerId（客户端用来反查是谁的流）
    const myConsumers = [...peer._consumers.values()].map(c => ({
      id:         c.id,
      producerId: c.producerId,
      kind:       c.kind,
      paused:     c.paused,
      peerId:     c.appData?.peerId || '',
    }));

    // 收集当前房间其他成员的流
    const existingPeers = room.getPeers()
      .filter(p => p.id !== peerId)
      .map(p => p.toJSON());

    // 关闭旧 Transport（会触发 Consumer/Producer 的 transportclose）
    // Consumer 会自动 close，Producer 也会自动 close
    // 这是预期行为：客户端重建 Transport 后会重新 produce + consume
    peer._transports.forEach(t => {
      try { t.close(); } catch(e) {}
    });
    peer._transports.clear();
    // Transport 关闭后 Producer/Consumer 已被自动清理
    // 清空 Map，准备接受新的
    peer._producers.clear();
    peer._consumers.clear();

    this._reply(socket, requestId, {
      type:         'rejoined',
      roomId,
      peerId,
      existingPeers,
      myProducers,   // 服务端还保留的 Producer
      myConsumers,   // 服务端还保留的 Consumer
    });

    room.broadcast(peerId, { type:'peerRejoined', peerId });
    console.log('[Signaling] peer=' + peerId + ' 重连恢复，' +
      myProducers.length + ' producers, ' + myConsumers.length + ' consumers');
  }

  // ── 加入房间 ──
  async _onJoin(socket, msg, requestId) {
    const { roomId, peerId, rtpCapabilities } = msg;
    let room = this._rooms.get(roomId);
    if (!room) {
      const worker = this._workerManager.getWorker();
      room = await this._Room.create(roomId, worker);
      this._rooms.set(roomId, room);
    }

    // 检查重复 peerId
    if (room.getPeer(peerId)) {
      throw new Error('peerId ' + peerId + ' 已在房间中');
    }

    const peer            = new Peer(peerId, socket);
    peer._rtpCapabilities = rtpCapabilities;
    room.addPeer(peer);
    socket._peer   = peer;
    socket._roomId = roomId;

    const existingPeers = room.getPeers()
      .filter(p => p.id !== peerId)
      .map(p => p.toJSON());

    // 支持 rejoin fallback：如果是从 _onRejoin 调过来的，回 rejoined
    const replyType = msg._replyType || 'joined';
    this._reply(socket, requestId, { type:replyType, roomId, peerId, existingPeers,
      myProducers:[], myConsumers:[] });
    room.broadcast(peerId, { type:'peerJoined', peerId });
    console.log('[Signaling] peer=' + peerId + ' 加入 ' + roomId + ' 共' + room.getPeers().length + '人');
  }

  // ── 创建 Transport ──
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

  // ── 连接 Transport ──
  async _onConnectTransport(socket, msg, requestId) {
    const { transportId, dtlsParameters } = msg;
    await this._getRoom(socket).connectTransport(socket._peer, transportId, dtlsParameters);
    this._reply(socket, requestId, { type:'transportConnected', transportId });
  }

  // ── ICE Restart ──
  async _onRestartIce(socket, msg, requestId) {
    const { transportId } = msg;
    const room = this._getRoom(socket);
    const iceParameters = await room.restartIce(socket._peer, transportId);
    console.log('[Signaling] ICE Restart peer=' + socket._peer.id);
    this._reply(socket, requestId, { type:'iceRestarted', transportId, iceParameters });
  }

  // ── 发布媒体流 ──
  async _onProduce(socket, msg, requestId) {
    const { transportId, kind, rtpParameters, appData } = msg;
    const producerId = await this._getRoom(socket).produce(
      socket._peer, transportId, kind, rtpParameters, appData
    );
    this._reply(socket, requestId, { type:'produced', id:producerId });
  }

  // ── 订阅媒体流 ──
  async _onConsume(socket, msg, requestId) {
    const { producerPeerId, producerId } = msg;
    const room         = this._getRoom(socket);
    const producerPeer = room.getPeer(producerPeerId);
    if (!producerPeer) throw new Error('Peer ' + producerPeerId + ' 不存在');
    const data = await room.consume(socket._peer, producerPeer, producerId);
    if (!data) {
      this._reply(socket, requestId, { type:'consumeFailed', producerId });
      return;
    }
    this._reply(socket, requestId, { type:'consumed', ...data });
  }

  // ── 恢复 Consumer ──
  async _onResumeConsumer(socket, msg, requestId) {
    const { consumerId } = msg;
    const consumer = socket._peer.getConsumer(consumerId);
    if (!consumer) throw new Error('Consumer ' + consumerId + ' 不存在');
    await consumer.resume();
    this._reply(socket, requestId, { type:'consumerResumed', consumerId });
  }

  // ── 暂停 Producer（静音/关摄像头）──
  async _onPauseProducer(socket, msg, requestId) {
    const { producerId } = msg;
    const producer = socket._peer.getProducer(producerId);
    if (!producer) throw new Error('Producer ' + producerId + ' 不存在');
    await producer.pause();
    this._reply(socket, requestId, { type:'producerPaused', producerId });
  }

  // ── 恢复 Producer ──
  async _onResumeProducer(socket, msg, requestId) {
    const { producerId } = msg;
    const producer = socket._peer.getProducer(producerId);
    if (!producer) throw new Error('Producer ' + producerId + ' 不存在');
    await producer.resume();
    this._reply(socket, requestId, { type:'producerResumed', producerId });
  }

  // ── 设置 Simulcast 层 ──
  async _onSetPreferredLayers(socket, msg, requestId) {
    const { consumerId, spatialLayer, temporalLayer } = msg;
    const consumer = socket._peer.getConsumer(consumerId);
    if (!consumer) throw new Error('Consumer ' + consumerId + ' 不存在');
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    this._reply(socket, requestId, { type:'preferredLayersSet', consumerId });
  }

  // ── 统计 ──
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

  // ── 断线 ──
  _onClose(socket) {
    const peer   = socket._peer;
    const roomId = socket._roomId;
    if (!peer || !roomId) return;
    const room = this._rooms.get(roomId);
    if (!room) return;
    room.removePeer(peer.id);
    room.broadcast(peer.id, { type:'peerLeft', peerId:peer.id });
    if (room.isEmpty) {
      // 不立即删除，等空房间清理器处理
      console.log('[Signaling] 房间 ' + roomId + ' 已空');
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
