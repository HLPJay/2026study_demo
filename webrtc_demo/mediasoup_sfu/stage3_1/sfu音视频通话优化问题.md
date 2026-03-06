基于mediasoup已经实现了一个支持多人语音通话的sfu项目，再次回顾，对已知的几个问题进行优化：

1.考虑收集客户端网络和系统相关状态。

2.考虑观察服务端网络相关状态。

3.基本的防护考虑，在ice断开的情况下，在客户端切换网络的场景下业务的处理。



====》借助ai做项目实践，这里的内容也略感空泛，但总归是自己梳理思路处理的过程，做笔记进行备份。

## 1.总结

本来考虑的是基于已有的sfu功能，如何统计网络状态，再探索到网络断开问题，尝试基于已有的项目进行优化的问题。

![image-20260306225825340](C:\Users\yun68\AppData\Roaming\Typora\typora-user-images\image-20260306225825340.png)

不关注内部详细细节，以自己宏观的角度上分析一下该项目交互流。

![image-20260307020235941](C:\Users\yun68\AppData\Roaming\Typora\typora-user-images\image-20260307020235941.png)

## 2.实践回顾

### 1.客户端监控信息统计功能

这里实际上是由本地发送端链路和用于接收远端流的接收链路，分别统计其信息，定时器按需进行显示和打印：

核心需要统计的信息如下：

```
发送质量（我的推流状况）
  qualityLimit  → 我的编码器是否被限制
  RTT           → 我到服务器的延迟
  send.jitter   → 我发出去的抖动
  retransmitted → 我重传了多少包

接收质量（我收到的每一路流）
  lossRate      → 每路流各自的丢包率
  jitterBuf     → 每路流各自的缓冲延迟
  fps           → 每路流各自的帧率
  nackCount     → 每路流触发了多少次重传请求
  pliCount      → 每路流触发了多少次关键帧请求
```

## 2.服务端的信息监控统计

提供专门的http服务入口，用于支持获取服务端本地必要的一些监控信息。

比如：通过url获取到服务器的一些必要监控信息：http://XXX.XXX.XXX.XXX:8445/health  （代码中提供了接口），可以用其他接口获取房间信息等自己期望的信息，这里可以考虑扩展为一个监控系统。

```
{
  "status": "ok",
  "timestamp": "2026-03-06T15:09:44.130Z",
  "workers": [
    {
      "pid": 2102963,
      "cpuMs": 0,
      "memMB": 13
    },
    {
      "pid": 2102965,
      "cpuMs": 0,
      "memMB": 10
    }
  ],
  "totals": {
    "rooms": 1,
    "peers": 2,
    "producers": 2,
    "consumers": 2
  }
}
```

### 3.房间断线重连机制

服务端提供了一个wss入口，供客户端主动连接，是所有开始的入口。

基于该wss入口，客户端通过协议控制实现加入房间，媒体协商，以及ice协商，创建发送链路和接收链路（流媒体交互链路，基于ice，一个链路发送多个流，SSRC识别）。

所以这里的断线有两种：

​		第一：网络原因，流媒体交互链路异常，需要ice重新建链。  

​		第二：客户端切换网络，直接和服务器wss的链路断开。

====》虽然网络断开，但是可以根据服务端wss信息以及本地内存已经保存的信息进行恢复，全是代码控制细节逻辑，不涉及技术。

====》切换网络，涉及本地和服务端房间管理资源的清理和重置逻辑稍多。

```
断线期间不能丢的状态：

myPeerId    → 我是谁，rejoin 用
myRoomId    → 我在哪个房间，rejoin 用
device      → 编解码能力，已经协商好，可以复用
camStream   → 摄像头的 MediaStream，track 还活着
micStream   → 麦克风的 MediaStream，track 还活着
camOn       → 摄像头是否开启的状态
micOn       → 麦克风是否开启的状态
muted       → 是否静音
remotePeers → 断线前房间里有哪些人（rejoin 后会用服务端数据更新）

断线时主动清理的状态（无法复用）：

sendTransport   → IP 变了，必须重建
recvTransport   → IP 变了，必须重建
camProducer     → Transport 销毁后自动失效
micProducer     → Transport 销毁后自动失效
consumers       → Transport 销毁后自动失效
pendingReqs     → WSS 断了，所有等待中的请求全部 reject
```



目标关注问题相关测试代码问题已经修改，测试已经通过：