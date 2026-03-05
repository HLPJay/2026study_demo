// Room.js
// 代表一个会议房间
// 管理房间内所有 Peer 以及 mediasoup Router

const config = require('./config');

class Room {
  constructor(roomId, router) {
    this.id      = roomId;
    this.router  = router;   // mediasoup Router
    this._peers  = new Map(); // peerId → Peer
  }

  // ── 静态工厂：创建房间（需要先创建 Router）──
  static async create(roomId, worker) {
    const router = await worker.createRouter({
      mediaCodecs: config.router.mediaCodecs
    });
    console.log(`[Room] 创建房间 ${roomId} routerId=${router.id}`);
    return new Room(roomId, router);
  }

  // ── Peer 管理 ──
  addPeer(peer) {
    this._peers.set(peer.id, peer);
  }

  getPeer(peerId) {
    return this._peers.get(peerId);
  }

  getPeers() {
    return [...this._peers.values()];
  }

  removePeer(peerId) {
    const peer = this._peers.get(peerId);
    if (peer) {
      peer.close();
      this._peers.delete(peerId);
    }
  }

  get isEmpty() {
    return this._peers.size === 0;
  }

  // ── 广播给房间内除某人外的所有成员 ──
  broadcast(excludePeerId, msg) {
    this._peers.forEach((peer, peerId) => {
      if (peerId !== excludePeerId) {
        peer.send(msg);
      }
    });
  }

  // ══════════════════════════════════════════
  //  mediasoup 核心操作
  // ══════════════════════════════════════════

  // ── 创建 WebRtcTransport ──
  async createWebRtcTransport(peer) {
    const transport = await this.router.createWebRtcTransport(
      config.webRtcTransport
    );

    // 监控 Transport 状态
    transport.on('dtlsstatechange', (state) => {
      console.log(`[Transport] peer=${peer.id} dtls=${state}`);
      if (state === 'failed' || state === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log(`[Transport] 关闭 peer=${peer.id} id=${transport.id}`);
    });

    peer.addTransport(transport);

    // 返回客户端需要的参数（用于建立 WebRTC 连接）
    return {
      id:             transport.id,
      iceParameters:  transport.iceParameters,
      iceCandidates:  transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  // ── 连接 Transport（客户端完成 ICE/DTLS 后调用）──
  async connectTransport(peer, transportId, dtlsParameters) {
    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} 不存在`);
    await transport.connect({ dtlsParameters });
    console.log(`[Transport] 连接成功 peer=${peer.id}`);
  }

  // ── 创建 Producer（发布媒体流）──
  async produce(peer, transportId, kind, rtpParameters, appData) {
    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} 不存在`);

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { peerId: peer.id, ...appData }
    });

    peer.addProducer(producer);

    // 监控 Producer
    producer.on('score', (score) => {
      // Simulcast 层质量评分
      peer.send({
        type:       'producerScore',
        producerId: producer.id,
        score,
      });
    });

    producer.on('videoorientationchange', (orientation) => {
      console.log(`[Producer] 方向变化 peer=${peer.id}`, orientation);
    });

    console.log(`[Producer] 创建成功 peer=${peer.id} kind=${kind} id=${producer.id}`);

    // 通知房间内其他成员：有新的 Producer
    this.broadcast(peer.id, {
      type:       'newProducer',
      peerId:     peer.id,
      producerId: producer.id,
      kind:       producer.kind,
    });

    return producer.id;
  }

  // ── 创建 Consumer（订阅媒体流）──
  async consume(consumerPeer, producerPeer, producerId) {
    const producer = producerPeer.getProducer(producerId);
    if (!producer) throw new Error(`Producer ${producerId} 不存在`);

    // 检查接收端是否支持这个流的编解码器
    if (!this.router.canConsume({
      producerId:      producer.id,
      rtpCapabilities: consumerPeer._rtpCapabilities,
    })) {
      console.warn(`[Consumer] peer=${consumerPeer.id} 不支持该编解码器`);
      return null;
    }

    // 找到接收用的 Transport
    const transport = [...consumerPeer._transports.values()]
      .find(t => t.appData?.direction === 'recv');

    if (!transport) throw new Error('接收端 Transport 不存在');

    //这里底层会给consumer的type按需要赋值  "simple" / "simulcast" /"svc"
    const consumer = await transport.consume({
      producerId:      producer.id,
      rtpCapabilities: consumerPeer._rtpCapabilities,
      paused:          true,  // 先暂停，客户端 resume 后开始接收
      appData: {
        peerId:     producerPeer.id,
        producerId: producer.id,
      }
    });

    consumerPeer.addConsumer(consumer);

    // 监控 Consumer 质量
    consumer.on('score', (score) => {
      consumerPeer.send({
        type:       'consumerScore',
        consumerId: consumer.id,
        score,
      });
    });

    // 监控层切换
    consumer.on('layerschange', (layers) => {
      console.log(`[Consumer] 层切换 consumerId=${consumer.id}`, layers);
      consumerPeer.send({
        type:       'consumerLayersChanged',
        consumerId: consumer.id,
        layers,
      });
    });

    consumer.on('transportclose', () => consumer.close());
    consumer.on('producerclose', () => {
      consumerPeer.send({
        type:       'consumerClosed',
        consumerId: consumer.id,
      });
      consumer.close();
    });

    console.log(`[Consumer] 创建成功 consumer=${consumerPeer.id} ← producer=${producerPeer.id} kind=${consumer.kind}`);

    return {
      id:            consumer.id,
      producerId:    producer.id,
      kind:          consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type:          'consumed',
      consumerType:  consumer.type, //这个会被底层修改
      appData:       consumer.appData,
    };
  }

  close() {
    this._peers.forEach(peer => peer.close());
    this.router.close();
    console.log(`[Room] 房间 ${this.id} 已关闭`);
  }
}

module.exports = Room;
