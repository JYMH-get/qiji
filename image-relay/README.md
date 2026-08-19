# image-relay 境外取件节点

解决的问题：上游图像 API 只返回文件直链，直链所在的存储域名从境内访问极慢/超时。
本服务部署在境外（香港/新加坡）云主机上，收到主服务器发来的直链后在境外完成下载，
再通过 OSS **传输加速端点**（阿里云骨干网，合规通道）转存到你们自己的 bucket。

```
上游API ──直链──> 主服务器（境内）
                     │ POST /fetch {url, key}
                     ▼
              image-relay（香港/新加坡）
                     │ 下载（境外访问直链无障碍）
                     ▼
              你们的 OSS bucket（走 oss-accelerate 加速端点上传）
                     ▼
              主服务器拿到 OSS/CDN 地址，落库、下发给用户
```

## 一、OSS 侧准备（一次性，约 10 分钟）

1. **开启传输加速**：OSS 控制台 → 你的 bucket → 传输加速 → 开启。
   注意：加速流量单独计费（约 1 元/GB 量级，以控制台计费说明为准）。
   按单图 2MB 估算，1 万张图 ≈ 20GB ≈ 二十几块钱。
2. **建最小权限 RAM 用户**：RAM 控制台新建用户（仅编程访问），创建自定义权限策略绑定给它：

   ```json
   {
     "Version": "1",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["oss:PutObject"],
         "Resource": ["acs:oss:*:*:你的bucket名/relay/*"]
       }
     ]
   }
   ```

   这样即使节点被攻破，对方也只能往 `relay/` 前缀写文件，读不了、删不了任何东西。
3. 记下 AccessKey ID/Secret，填进 `.env`。

## 二、买机器并部署（约 20 分钟）

1. 买一台**香港或新加坡**的轻量应用服务器（阿里云轻量 HK 最低配即可，约 24~34 元/月），
   系统选 Debian/Ubuntu。
2. 安全组：**8787 端口只放行你们主服务器的公网 IP**，其余全拒。这是第一道防线，token 是第二道。
3. 装 Node 20 并部署：

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
   ```

   把本目录整个 `scp` 上去（不含 node_modules），然后：

   ```bash
   cd image-relay && npm install --omit=dev
   cp .env.example .env && vim .env   # 填写配置
   ```

4. 用 systemd 常驻，新建 `/etc/systemd/system/image-relay.service`：

   ```ini
   [Unit]
   Description=image relay
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/image-relay
   EnvironmentFile=/opt/image-relay/.env
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=3
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now image-relay
   ```

## 三、验证

在主服务器上执行（用一条真实的上游直链）：

```bash
curl -X POST http://节点IP:8787/fetch \
  -H "Authorization: Bearer 你的RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://上游直链...","key":"relay/test/first.png"}'
```

成功返回：

```json
{ "ok": true, "key": "relay/test/first.png", "url": "https://cdn.../relay/test/first.png", "bytes": 2048576, "contentType": "image/png", "ms": 3200 }
```

健康检查：`GET /healthz`（可接你们现有的监控/uptime 探测）。

## 四、主服务器接入（TypeScript 示例）

拿到上游直链后**立刻**调用（直链多为带签名的临时地址，别排队等）：

```ts
const RELAY = 'http://节点IP:8787';
const RELAY_TOKEN = process.env.RELAY_TOKEN!;

export async function relayImage(upstreamUrl: string, key: string): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${RELAY}/fetch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RELAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: upstreamUrl, key }),
        signal: AbortSignal.timeout(120_000), // 下载+上传全程，给足 2 分钟
      });
      const data = await res.json();
      if (data.ok) return data.url as string;
      throw new Error(data.error);
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

// 用法：生成任务回调里
// const ossUrl = await relayImage(直链, `relay/${userId}/${taskId}.png`);
// 落库 ossUrl，前端只见你们自己的 CDN 域名
```

建议把这一步放进异步任务流（队列/回调），不要挡在用户请求的同步路径上。

## 五、运维备忘

- **监控**：uptime 服务盯 `/healthz`；`journalctl -u image-relay -f` 看日志，每次转存一行（成功含耗时/体积，失败含原因）。
- **ALLOWED_HOSTS 务必配置**：填两家上游直链的域名。不配的话，一旦 token 泄露，这台节点就是开放代理。
- **腾讯云 COS 用户**：把 `ali-oss` 换成 `cos-nodejs-sdk-v5`，上传用 COS 的全球加速域名
  （`<bucket>.cos.accelerate.myqcloud.com`），`server.js` 里只需替换 `oss.put(...)` 那一处。
- **扩容**：单节点并发 4 路下载已够大多数场景；量大了把 MAX_CONCURRENCY 调到 8，
  或再买一台节点、主服务器轮询两个地址即可，服务本身无状态。
