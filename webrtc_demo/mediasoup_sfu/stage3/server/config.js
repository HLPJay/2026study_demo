// config.js
const os = require('os');

module.exports = {

  // ── 信令服务器 ──
  signaling: {
    port: 8444,
    // 证书路径（复用 mediasoup-demo 的证书）
    cert: '/home/mediasoup/certs/selfsigned.crt',
    key:  '/home/mediasoup/certs/selfsigned.key',
  },

  // ── mediasoup Worker ──
  worker: {
    // Worker 数量 = CPU 核数
    numWorkers:   os.cpus().length,
    logLevel:     'warn',
    logTags:      ['info','ice','dtls','rtp','srtp','rtcp'],
    rtcMinPort:   40000,
    rtcMaxPort:   49999,
  },

  // ── Router（房间级别）──
  router: {
    mediaCodecs: [
      // ── 音频：Opus ──
      {
        kind:      'audio',
        mimeType:  'audio/opus',
        clockRate: 48000,
        channels:  2,
        parameters: {
          'useinbandfec': 1,  // 开启 FEC
          'usedtx':       1,  // 静音时降码率
        }
      },
      // ── 视频：VP8 ──
      {
        kind:      'video',
        mimeType:  'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
      // ── 视频：VP8 RTX（重传）──
      // {
      //   kind:      'video',
      //   mimeType:  'video/rtx',
      //   clockRate: 90000,
      //   parameters: { apt: 96 }  // 对应 VP8 的 payloadType
      // },
      // ── 视频：H264 ──
      {
        kind:      'video',
        mimeType:  'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode':      1,
          'profile-level-id':        '42e01f', // Baseline，无B帧
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate':  1000,
        },
        //rtcp返回消息
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'ccm', parameter: 'fir' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      },
    ]
  },

  // ── WebRtcTransport ──
  webRtcTransport: {
    listenIps: [
      {
        ip:          '0.0.0.0',
        announcedIp: process.env.PUBLIC_IP || '47.95.43.204',
      }
    ],
    initialAvailableOutgoingBitrate: 1_000_000, // 1Mbps
    minimumAvailableOutgoingBitrate:   600_000, // 600kbps
    maxSctpMessageSize: 262144,
    // 带宽估计配置
    enableUdp:  true,
    enableTcp:  true,
    preferUdp:  true,
  },

  // ── Simulcast 编码层 ──
  simulcast: {
    encodings: [
      // 低清层
      {
        rid:                   'l',
        maxBitrate:            100_000,
        scalabilityMode:       'S1T3',
        scaleResolutionDownBy: 4,
      },
      // 中清层
      {
        rid:                   'm',
        maxBitrate:            300_000,
        scalabilityMode:       'S1T3',
        scaleResolutionDownBy: 2,
      },
      // 高清层
      {
        rid:             'h',
        maxBitrate:      900_000,
        scalabilityMode: 'S1T3',
      },
    ],
    // 编解码器参数
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    }
  },
};
