// index.js
const mediasoup      = require('mediasoup');
const http            = require('http');
const config         = require('./config');
const Room       = require('./Room');
const SignalingServer = require('./SignalingServer');

// 房间管理
const rooms  = new Map();  // roomId → Room

// Worker 池
const workers = [];
let workerIdx = 0;

// Worker 管理器
const workerManager = {
  getWorker() {
    const worker = workers[workerIdx];
    workerIdx = (workerIdx + 1) % workers.length;
    return worker;
  }
};

async function main() {
  console.log('[Main] 启动 mediasoup SFU 服务器...');

  // ── 创建 mediasoup Workers ──
  const { numWorkers } = config.worker;
  console.log(`[Main] 创建 ${numWorkers} 个 Worker`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel:   config.worker.logLevel,
      logTags:    config.worker.logTags,
      rtcMinPort: config.worker.rtcMinPort,
      rtcMaxPort: config.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error(`[Worker] Worker pid ${worker.pid} 崩溃，3秒后退出`);
      setTimeout(() => process.exit(1), 3000);
    });

    workers.push(worker);
    console.log(`[Main] Worker ${i + 1}/${numWorkers} 创建成功 pid=${worker.pid}`);
  }

  // ── 启动信令服务器 ──
  // 修复：SignalingServer 内部 require Room，需要先修复循环依赖
  // 直接把 Room 传进去
  // const signalingServer = new SignalingServer(rooms, workerManager);

  // // 修复：SignalingServer._onJoin 里直接 require('./Room')
  // // 改成通过参数传入
  // signalingServer._Room = Room;

  const signalingServer = new SignalingServer(rooms, workerManager, Room);


  signalingServer.start();

  // ── Worker 资源监控（每30秒）──
  startWorkerMonitor();

  // ── 空房间清理（每60秒）──
  startRoomCleaner();

  // ── 健康检查 HTTP 接口 ──
  startHealthServer();
  
  console.log('[Main] ✓ 服务器启动完成');
  console.log(`[Main] 信令端口: ${config.signaling.port}`);
  console.log(`[Main] 健康检查: http://localhost:8445/health`);
  console.log(`[Main] 媒体端口: ${config.worker.rtcMinPort}-${config.worker.rtcMaxPort}`);
}

// ══════════════════════════════════════════════
//  Worker 资源监控
// ══════════════════════════════════════════════
function startWorkerMonitor() {
  setInterval(async () => {
    for (const worker of workers) {
      try {
        const usage = await worker.getResourceUsage();
        const cpuMs = Math.round((usage.ru_utime + usage.ru_stime) / 1000);
        const memMB = Math.round(usage.ru_maxrss / 1024);

        if (cpuMs > 80 || memMB > 800) {
          console.warn(`[Worker] pid=${worker.pid} CPU=${cpuMs}% MEM=${memMB}MB ⚠️ 资源告警`);
        } else {
          console.log(`[Worker] pid=${worker.pid} CPU=${cpuMs}% MEM=${memMB}MB`);
        }
      } catch(e) {
        console.error(`[Worker] 获取资源使用失败: ${e.message}`);
      }
    }
  }, 30000);
}

// ══════════════════════════════════════════════
//  空房间清理
// ══════════════════════════════════════════════
function startRoomCleaner() {
  setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      // 空房间超过 60 秒删除
      if (room.isEmpty) {
        const idleSec = Math.round((now - (room._lastEmptyAt || now)) / 1000);
        if (!room._lastEmptyAt) {
          room._lastEmptyAt = now;
        } else if (idleSec > 60) {
          console.log(`[Cleaner] 清理空房间 ${roomId} 空闲${idleSec}s`);
          room.close();
          rooms.delete(roomId);
        }
      } else {
        // 有人在，重置计时
        room._lastEmptyAt = null;
      }
    }
  }, 60000);
}

// ══════════════════════════════════════════════
//  健康检查 HTTP 接口
// ══════════════════════════════════════════════
function startHealthServer() {
  http.createServer(async (req, res) => {

    // ── /health ──
    if (req.url === '/health') {
      const data = await buildHealthReport();
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    // ── /stats ──
    if (req.url === '/stats') {
      const data = await buildFullStats();
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    // ── /rooms ──
    if (req.url === '/rooms') {
      const data = [];
      for (const [roomId, room] of rooms) {
        data.push({
          roomId,
          peers:   room.getPeers().map(p => p.id),
          uptime:  Math.round((Date.now() - room.createdAt) / 1000),
        });
      }
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');

  }).listen(8445, '0.0.0.0', () => {
    console.log('[Health] HTTP 接口启动 port=8445');
  });
}

async function buildHealthReport() {
  const report = {
    status:    'ok',
    timestamp: new Date().toISOString(),
    workers:   [],
    totals: {
      rooms:     rooms.size,
      peers:     0,
      producers: 0,
      consumers: 0,
    }
  };

  // Worker 状态
  for (const worker of workers) {
    try {
      const u = await worker.getResourceUsage();
      const cpuMs = Math.round((u.ru_utime + u.ru_stime) / 1000);
      const memMB = Math.round(u.ru_maxrss / 1024);
      report.workers.push({ pid:worker.pid, cpuMs, memMB });
      if (cpuMs > 80) report.status = 'warning';
    } catch(e) {
      report.workers.push({ pid:worker.pid, error:e.message });
      report.status = 'warning';
    }
  }

  // 房间汇总
  for (const room of rooms.values()) {
    const peers = room.getPeers();
    report.totals.peers += peers.length;
    for (const peer of peers) {
      report.totals.producers += peer._producers.size;
      report.totals.consumers += peer._consumers.size;
    }
  }

  return report;
}

async function buildFullStats() {
  const stats = { rooms:[] };
  for (const room of rooms.values()) {
    try {
      stats.rooms.push(await room.getStats());
    } catch(e) {}
  }
  return stats;
}

// ══════════════════════════════════════════════
//  进程退出清理
// ══════════════════════════════════════════════
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  console.log(`[Main] 收到 ${signal}，清理资源...`);
  rooms.forEach(room => room.close());
  process.exit(0);
}

main().catch(err => {
  console.error('[Main] 启动失败:', err);
  process.exit(1);
});
