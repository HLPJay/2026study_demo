// index.js
const mediasoup      = require('mediasoup');
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
      console.error(`[Worker] Worker ${worker.pid} 崩溃，3秒后退出`);
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

  console.log('[Main] ✓ 服务器启动完成');
  console.log(`[Main] 信令端口: ${config.signaling.port}`);
  console.log(`[Main] 媒体端口: ${config.worker.rtcMinPort}-${config.worker.rtcMaxPort}`);
}

main().catch(err => {
  console.error('[Main] 启动失败:', err);
  process.exit(1);
});
