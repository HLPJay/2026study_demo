### 服务端的配置

这里我用的自己的云服务器

```bash
mkdir server

# 服务端依赖
cd server
npm init -y
npm install mediasoup ws uuid

stage3/
├── server/
│   ├── index.js          # 入口
│   ├── config.js         # mediasoup 配置   这里的相关mediasoup配置信息很重要
│   ├── Room.js           # 房间管理
│   ├── Peer.js           # 单个成员
│   └── SignalingServer.js # WebSocket 信令  
    
server端：node index.js
```

遇到一个小问题，核心是配置config.js中的编解码支持sdp配置：

设置主编码器和辅助编码器：不能把辅助编码器设置为主编码器

| 类型                                | 例子                                                         | 作用                                                         | 是否需要显式配置在 mediasoup 的 mediaCodecs 里？             | 为什么？                                                     |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **主媒体 codec** (media codec)      | audio/opus video/VP8 video/H264 video/VP9                    | 真正负责编码/解码原始音频或视频内容（压缩核心数据）          | **必须** 配置（createRouter 时传入 mediaCodecs 数组）        | 这是媒体的“主体”，router 需要知道支持哪些真正的编码格式      |
| **feature codec** (特性/辅助 codec) | video/rtx video/FEC (如 ulpfec、flexfec) audio/RED (有时也算) | **不编码原始媒体**，而是提供额外功能（如重传、纠错、前向纠错） | **禁止** 配置在 mediaCodecs 里（官方明确说 MUST NOT / must NOT） | 这些不是独立的媒体编码器，而是“附加功能”。mediasoup 会根据主 codec 的 rtcpFeedback（如 nack）自动启用 RTX 支持，不需要手动加 rtx codec |

遇到第二个小问题：浏览器在加入房间后，请求流的时候，consume对应的回应消息类型不匹配。

===》关注该消息的处理函数，回复消息时用到mediasoup底层在创建consumer时（基于封装后的transport），如果回复类型直接用consumer.type（mediasoup的机制 识别为“simple（单码率RTP） / simulcast（多路编码，多 SSRC 、多 RID） / svc（可伸缩视频编码）”），客户端处理不匹配导致的，需要指定识别type为客户端期望处理的类型。

===》这里的VP9/AV1支持的可伸缩编码方式（svc），simulcast（多路编码）都是自适应码率的支持。

### 客户端静态托管配置

注意得配置认证，浏览器才能https进行访问。

```bash
npm create vite@latest mediasoup-test
cd mediasoup-test
npm install

npm install mediasoup-client
#这里增加自己的html客户端代码  stage3-client.html
npm run dev

#这里要支持浏览器上的直接访问，
oot@aliy:/home/webrct_project/client3/mediasoup-test# cat vite.config.js 
import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

export default defineConfig({
  // ── 开发服务器配置 ───────────────────────────────────────────────
  server: {
    // 必须设置为 true 或 '0.0.0.0'，才能让公网访问
    host: true,              // 或者写成 '0.0.0.0'

    // 默认 5173，你可以改成 8444 或其他
    port: 5555,

    // 开启 HTTPS，并使用证书
    https: {
      // 证书路径（绝对路径）
      key: fs.readFileSync('/home/mediasoup/certs/selfsigned.key'),
      cert: fs.readFileSync('/home/mediasoup/certs/selfsigned.crt'),
    },

    // 可选：热更新使用 wss（WebSocket Secure）
    hmr: {
      protocol: 'wss',
      // 域名；否则保持默认（用 IP 访问时会自动适配）
      // host: 'your-domain.com',
    },
  },
})

```

这里遇到的问题是，使用静态html+<script src="https://unpkg.com/mediasoup-client@3/dist/mediasoup.min.js"></script>访问的方式，一直无法正常获取到，不支持这种方式，直接以npm install mediasoup-client及vite打包的方式。