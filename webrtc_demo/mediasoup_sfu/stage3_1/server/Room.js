// Room.js
// 代表一个会议房间
// 管理房间内所有 Peer 以及 mediasoup Router

const config = require('./config');

class Room {
  constructor(roomId, router) {
    this.id       = roomId;
    this.router   = router;
    this._peers   = new Map();
    this.createdAt = Date.now();

    // 房间级统计
    this._stats = {
      totalPeersJoined:  0,
      totalProducers:    0,
      totalConsumers:    0,
      peakPeerCount:     0,
    };

    // 空房间清理定时器
    this._emptyTimer = null;
  }

  // ── 静态工厂：创建房间（需要先创建 Router）──
  static async create(roomId, worker) {
    const router = await worker.createRouter({
      mediaCodecs: config.router.mediaCodecs
    });
    console.log(`[Room] 创建房间 ${roomId} routerId=${router.id}`);
    return new Room(roomId, router);
  }

  // ══════════════════════════════════════════
  //  Peer 管理
  // ══════════════════════════════════════════
  addPeer(peer) {
    this._peers.set(peer.id, peer);
    this._stats.totalPeersJoined++;
    if (this._peers.size > this._stats.peakPeerCount)
      this._stats.peakPeerCount = this._peers.size;
    if (this._emptyTimer) {
      clearTimeout(this._emptyTimer);
      this._emptyTimer = null;
    }
  }

  getPeer(peerId)  { return this._peers.get(peerId); }
  getPeers()       { return [...this._peers.values()]; }

  removePeer(peerId) {
    const peer = this._peers.get(peerId);
    if (!peer) return;
    peer.close();
    this._peers.delete(peerId);
    console.log(`[Room] peer=${peerId} 移除，剩余${this._peers.size}人`);
  }

  get isEmpty() { return this._peers.size === 0; }

  broadcast(excludePeerId, msg) {
    this._peers.forEach((peer, id) => {
      if (id !== excludePeerId) peer.send(msg);
    });
  }

  // ══════════════════════════════════════════
  //  Transport
  // ══════════════════════════════════════════

  // ── 创建 WebRtcTransport ──
  async createWebRtcTransport(peer) {
    const transport = await this.router.createWebRtcTransport(
      config.webRtcTransport
    );

    // DTLS 状态监控
    transport.on('dtlsstatechange', (state) => {
      console.log(`[Transport] peer=${peer.id} dtls=${state}`);
      if (state === 'failed' || state === 'closed') {
        transport.close();
      }
    });

    // ICE 状态监控
    transport.on('icestatechange', (state) => {
      console.log(`[Transport] peer=${peer.id} ice=${state}`);
      // ICE 断开时通知客户端
      if (state === 'disconnected' || state === 'failed') {
        peer.send({
          type:        'transportIceState',
          transportId: transport.id,
          state,
        });
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
    console.log(`[Transport] 连接成功 peer=${peer.id} id=${transportId}`);
  }

  // ICE Restart（客户端请求重启 ICE）
  async restartIce(peer, transportId) {
    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} 不存在`);
    const iceParameters = await transport.restartIce();
    console.log(`[Transport] ICE Restart peer=${peer.id}`);
    return iceParameters;
  }

  // ══════════════════════════════════════════
  //  Producer
  // ══════════════════════════════════════════
  async produce(peer, transportId, kind, rtpParameters, appData) {
    const transport = peer.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} 不存在`);

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { peerId: peer.id, ...appData }
    });

    peer.addProducer(producer);
    this._stats.totalProducers++;

    // 质量分监控
    producer.on('score', (score) => {
      peer.send({ type:'producerScore', producerId:producer.id, score });

      // 质量分持续过低告警
      const minScore = Array.isArray(score)
        ? Math.min(...score.map(s => s.score))
        : score.score;
      if (minScore < 3) {
        console.warn(`[Producer] 质量过低 peer=${peer.id} score=${minScore}`);
      }
    });

    producer.on('videoorientationchange', (orientation) => {
      console.log(`[Producer] 方向变化 peer=${peer.id}`, orientation);
    });

    producer.on('close', () =>
      console.log(`[Producer] 关闭 peer=${peer.id} id=${producer.id}`)
    );

    console.log(`[Producer] 创建 peer=${peer.id} kind=${kind} id=${producer.id}`);

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
    this._stats.totalConsumers++;

    // 监控 Consumer 质量
    consumer.on('score', (score) => {
      consumerPeer.send({ type:'consumerScore', consumerId:consumer.id, score });

      // 根据分数自动切换 Simulcast 层
      if (consumer.kind === 'video') {
        const s = Array.isArray(score)
          ? Math.min(...score.map(x => x.score))
          : score.score;
        const layer = s >= 8 ? 2 : s >= 5 ? 1 : 0;
        consumer.setPreferredLayers({ spatialLayer:layer, temporalLayer:2 })
          .catch(() => {});
      }
    });

    // 层切换通知
    consumer.on('layerschange', (layers) => {
      console.log(`[Consumer] 层切换 id=${consumer.id}`, layers);
      consumerPeer.send({ type:'consumerLayersChanged', consumerId:consumer.id, layers });
    });

    consumer.on('transportclose', () => {
      console.log(`[Consumer] transportclose id=${consumer.id}`);
      consumer.close();
    });

    consumer.on('producerclose', () => {
      console.log(`[Consumer] producerclose id=${consumer.id}`);
      consumerPeer.send({ type:'consumerClosed', consumerId:consumer.id });
      consumer.close();
    });

    consumer.on('producerpause', () => {
      consumerPeer.send({ type:'consumerPaused', consumerId:consumer.id });
    });

    consumer.on('producerresume', () => {
      consumerPeer.send({ type:'consumerResumed2', consumerId:consumer.id });
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

  // ══════════════════════════════════════════
  //  统计采集
  // ══════════════════════════════════════════
  async getStats() {
    const stats = {
      roomId:    this.id,
      createdAt: this.createdAt,
      uptime:    Math.round((Date.now() - this.createdAt) / 1000),
      peers:     [],
      totals:    {
        peerCount:    this._peers.size,
        producerCount: 0,
        consumerCount: 0,
      },
      history: this._stats,
    };

    for (const peer of this._peers.values()) {
      const peerStat = {
        peerId:    peer.id,
        producers: [],
        consumers: [],
      };

      for (const producer of peer.getProducers()) {
        try {
          const s = await producer.getStats();
          const rtp = s.find(r => r.type === 'outbound-rtp') || {};
          peerStat.producers.push({
            id:      producer.id,
            kind:    producer.kind,
            score:   producer.score,
            bitrate: rtp.bitrate || 0,
            paused:  producer.paused,
          });
          stats.totals.producerCount++;
        } catch(e) {}
      }

      for (const consumer of peer._consumers.values()) {
        try {
          peerStat.consumers.push({
            id:             consumer.id,
            kind:           consumer.kind,
            score:          consumer.score,
            currentLayers:  consumer.currentLayers,
            paused:         consumer.paused,
          });
          stats.totals.consumerCount++;
        } catch(e) {}
      }

      stats.peers.push(peerStat);
    }

    return stats;
  }

  close() {
    if (this._emptyTimer) clearTimeout(this._emptyTimer);
    this._peers.forEach(peer => peer.close());
    this.router.close();
    console.log(`[Room] 关闭 ${this.id}`);
  }
}

module.exports = Room;
