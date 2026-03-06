// Peer.js
// 代表房间里的一个成员
// 管理该成员的所有 Transport/Producer/Consumer

class Peer {
  constructor(peerId, socket) {
    this.id       = peerId;
    this.socket   = socket;  // WebSocket 连接

    // 该成员的 Transport
    // 每个成员最多2个：sendTransport + recvTransport
    this._transports = new Map();  // transportId → transport

    // 该成员发布的流
    this._producers  = new Map();  // producerId → producer

    // 该成员订阅的流
    this._consumers  = new Map();  // consumerId → consumer
  }

  // ── Transport 管理 ──
  addTransport(transport) {
    this._transports.set(transport.id, transport);
  }

  getTransport(transportId) {
    return this._transports.get(transportId);
  }

  // ── Producer 管理 ──
  addProducer(producer) {
    this._producers.set(producer.id, producer);
  }

  getProducer(producerId) {
    return this._producers.get(producerId);
  }

  getProducers() {
    return [...this._producers.values()];
  }

  // ── Consumer 管理 ──
  addConsumer(consumer) {
    this._consumers.set(consumer.id, consumer);
  }

  getConsumer(consumerId) {
    return this._consumers.get(consumerId);
  }

  // ── 发送信令消息 ──
  send(msg) {
    if (this.socket.readyState === 1) {  // OPEN
      this.socket.send(JSON.stringify(msg));
    }
  }

  // ── 清理资源 ──
  close() {
    this._transports.forEach(t => t.close());
    this._producers.forEach(p => p.close());
    this._consumers.forEach(c => c.close());
  }

  // ── 序列化（发给其他成员的信息）──
  toJSON() {
    return {
      id:        this.id,
      producers: [...this._producers.values()].map(p => ({
        id:   p.id,
        kind: p.kind,
      }))
    };
  }
}

module.exports = Peer;
