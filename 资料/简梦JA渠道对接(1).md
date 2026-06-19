Seedance 2 · 异步生成
提供与 Seedance 2 同款字节跳动引擎的视频生成。包含按秒计费与按次计费（15秒固定时长）两种模式，分辨率与版本已编码进模型名（无需传 resolution）。支持纯文生视频、全能参考图、多素材混合参考（图片≤9、视频≤3、音频≤3）。

💡 真人 / 人脸素材小贴士：本系列基于 Seedance，直接上传清晰的真人正脸通过率偏低；建议先对人脸做处理（如遮挡 / 打码眼睛等关键部位）再上传，可明显提高成功率。

模型版本对比
调用名称（model 字段）|	适用场景
JA-sd2-fast-480 	| 快速版 480p，按秒计费，适合预览、草稿与大批量产出。
JA-sd2-fast-720 	| 快速版 720p，速度快、清晰度更高，日常首选。
JA-sd2-pro-480 	| 高质量版 480p，画质与运动一致性更好，适合正式成片或画质要求较高的场景。
JA-sd2-pro-720 	| 高质量版 720p，最高画质档，适合正式成片。
JA-sd2-fast-15s 	| 快速版 15s 固定时长，按次计费，适合批量产出和日常需求。
JA-sd2-pro-15s 	| 专业版 15s 固定时长，画质和运动一致性更高，适合对质量要求高的场景。
JA-sd2-pro-1080p | 1080p · 15s	固定时长，输出分辨率提升至 1080p，画面更清晰，适合对画质有严格要求的场景。

对接指南 异步轮询架构，三步获取产出
① 提交生成任务 (POST /v1/videos) 成功后网关将扣减预冻结金额，并返回 task_id → ② 进行周期轮询 (GET /v1/videos/{task_id}) 获知任务状态 → ③ 终态为 completed 时 获取我们在您的域名下签发的 CDN 链接进行下载并结算扣减。
⚠️ 结果链接仅保留 6 小时，超时后文件自动删除（任务记录永久保留），请在 6 小时内下载 / 转存。

URL：https://api.jian1.vip

POST
/v1/videos
1. 提交任务
响应示例 (Status: 200 OK)
复制
{
  "id": "task_385412",
  "task_id": "task_385412",
  "model": "JA-sd2-fast-480",
  "status": "processing",
  "progress": 0,
  "created_at": 1780219566
}
GET
/v1/videos/{task_id}
2. 轮询状态 (推荐间隔 8 秒)
cURL 轮询示例
复制
curl /v1/videos/task_385412 \
  -H "Authorization: Bearer sk-xxxxxxxx"
成功响应示例 (Status: 200 OK)
复制
{
  "task_id": "task_385412",
  "status": "completed",
  "model": "JA-sd2-fast-480",
  "video_url": "https://r2.artifex.help/outputs/vid_385412.mp4",
  "cover_url": "https://r2.artifex.help/outputs/cover_385412.jpg",
  "created_at": 1780219566,
  "finished_at": 1780219800
}
标准任务状态值机
queued	在网关队列排队，公平轮转中，继续轮询
dispatched	任务已进入生成队列。暂不结算
running	正在生成中，继续保持轮询
completed	已生成完毕。取 video_url 实扣结算
failed	生成失败，余额已自动冲正并全额退款

可用模型契约与细分参数
缺失 必填 参数会导致网关预校验失败拦截。

JA-sd2-fast-480
快速 · 480p
快速版 480p，按秒计费，适合预览、草稿与大批量产出。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-fast-480
prompt	string	必填	视频内容描述，建议英文。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），4–15，默认 15。按秒计费，此即计费单位
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1、21:9、3:4、4:3
image_url	string	可选	全能参考图 URL（公网 HTTPS）
extra_images	array	可选	参考图 URL 数组，最多 9 张，用 @Image1~@Image9 引用
extra_videos	array	可选	参考视频 URL 数组，最多 3 个，用 @Video1~@Video3 引用
extra_audios	array	可选	参考音频 URL 数组，最多 3 个，用 @Audio1~@Audio3 引用
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-480",
  "prompt": "A white cat sleeping on a windowsill with warm sunlight, cinematic",
  "duration": 6,
  "aspect_ratio": "16:9"
}'
请求示例 · 满血多素材混合参考 (含图片、视频、音频)
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-480",
  "prompt": "The girl in @Image1 is dancing in the street from @Image2, with background music like @Audio1",
  "duration": 6,
  "aspect_ratio": "9:16",
  "image_url": "https://example.com/first-frame.jpg",
  "extra_images": [
    "https://example.com/girl.jpg",
    "https://example.com/street.jpg"
  ],
  "extra_audios": [
    "https://example.com/bgm.mp3"
  ]
}'
⚠ 说明与限制

·
按秒计费：按视频实际生成时长结算。
·
分辨率固定 480p（由模型名决定，无需传 resolution）
·
素材限制：图片≤9 / 视频≤3 / 音频≤3，均需公网 HTTPS，且在 prompt 内用 @tag 引用才生效
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-fast-720
快速 · 720p
快速版 720p，速度快、清晰度更高，日常首选。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-fast-720
prompt	string	必填	视频内容描述，建议英文。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），4–15，默认 15。按秒计费，此即计费单位
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1、21:9、3:4、4:3
image_url	string	可选	全能参考图 URL（公网 HTTPS）
extra_images	array	可选	参考图 URL 数组，最多 9 张，用 @Image1~@Image9 引用
extra_videos	array	可选	参考视频 URL 数组，最多 3 个，用 @Video1~@Video3 引用
extra_audios	array	可选	参考音频 URL 数组，最多 3 个，用 @Audio1~@Audio3 引用
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-720",
  "prompt": "A golden retriever running on a sunny beach, slow motion, cinematic",
  "duration": 6,
  "aspect_ratio": "16:9"
}'
请求示例 · 满血多素材混合参考 (含图片、视频、音频)
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-720",
  "prompt": "The character in @Image1 walks through the scene in @Image2",
  "duration": 6,
  "aspect_ratio": "16:9",
  "image_url": "https://example.com/first-frame.jpg",
  "extra_images": [
    "https://example.com/char.jpg",
    "https://example.com/scene.jpg"
  ]
}'
⚠ 说明与限制

·
按秒计费：按视频实际生成时长结算。
·
分辨率固定 720p（16:9 = 1280×720）
·
素材限制：图片≤9 / 视频≤3 / 音频≤3，均需公网 HTTPS，且在 prompt 内用 @tag 引用才生效
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-pro-480
专业 · 480p
高质量版 480p，画质与运动一致性更好，适合正式成片或画质要求较高的场景。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-pro-480
prompt	string	必填	视频内容描述，建议英文。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），4–15，默认 15。按秒计费，此即计费单位
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1、21:9、3:4、4:3
image_url	string	可选	全能参考图 URL（公网 HTTPS）
extra_images	array	可选	参考图 URL 数组，最多 9 张，用 @Image1~@Image9 引用
extra_videos	array	可选	参考视频 URL 数组，最多 3 个，用 @Video1~@Video3 引用
extra_audios	array	可选	参考音频 URL 数组，最多 3 个，用 @Audio1~@Audio3 引用
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-pro-480",
  "prompt": "A cyberpunk city street at night with neon reflections, cinematic",
  "duration": 6,
  "aspect_ratio": "16:9"
}'
⚠ 说明与限制

·
按秒计费：按视频实际生成时长结算。
·
分辨率固定 480p（由模型名决定，无需传 resolution）
·
素材限制：图片≤9 / 视频≤3 / 音频≤3，均需公网 HTTPS
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-pro-720
专业 · 720p
高质量版 720p，最高画质档，适合正式成片。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-pro-720
prompt	string	必填	视频内容描述，建议英文。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），4–15，默认 15。按秒计费，此即计费单位
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1、21:9、3:4、4:3
image_url	string	可选	全能参考图 URL（公网 HTTPS）
extra_images	array	可选	参考图 URL 数组，最多 9 张，用 @Image1~@Image9 引用
extra_videos	array	可选	参考视频 URL 数组，最多 3 个，用 @Video1~@Video3 引用
extra_audios	array	可选	参考音频 URL 数组，最多 3 个，用 @Audio1~@Audio3 引用
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-pro-720",
  "prompt": "A cinematic aerial shot of a coastal town at dusk, ultra detail",
  "duration": 6,
  "aspect_ratio": "16:9"
}'
⚠ 说明与限制

·
按秒计费：按视频实际生成时长结算。
·
分辨率固定 720p（16:9 = 1280×720）
·
素材限制：图片≤9 / 视频≤3 / 音频≤3，均需公网 HTTPS
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-fast-15s
快速 · 15s
快速版 15s 固定时长，按次计费，适合批量产出和日常需求。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-fast-15s
prompt	string	必填	视频内容描述，建议英文，最大 2500 字符。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），在此模型下固定为 15，默认 15
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1
image_url	string	可选	全能参考图 URL（传入后模型以此图为整体视觉参考）
extra_images	array	可选	参考图 URL 数组，最多 9 张，用 @Image1~@Image9 引用
extra_videos	array	可选	参考视频 URL 数组，最多 3 个，用 @Video1~@Video3 引用
extra_audios	array	可选	参考音频 URL 数组，最多 3 个，用 @Audio1~@Audio3 引用
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-15s",
  "prompt": "A white cat sleeping on a windowsill with warm sunlight, cinematic",
  "duration": 15,
  "aspect_ratio": "16:9"
}'
请求示例 · 满血多素材混合参考 (含图片、视频、音频)
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-fast-15s",
  "prompt": "The girl in @Image1 is dancing in the street from @Image2, with background music like @Audio1",
  "duration": 15,
  "aspect_ratio": "16:9",
  "image_url": "https://example.com/first-frame.jpg",
  "extra_images": [
    "https://example.com/girl.jpg",
    "https://example.com/street.jpg"
  ],
  "extra_audios": [
    "https://example.com/bgm.mp3"
  ]
}'
⚠ 说明与限制

·
按次计费
·
视频时长固定 15 秒
·
视频输出分辨率 720p（16:9 = 1280×720）
·
素材限制：图片≤9 / 视频≤3 / 音频≤3，均需公网 HTTPS
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-pro-15s
专业 · 15s
专业版 15s 固定时长，画质和运动一致性更高，适合对质量要求高的场景。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-pro-15s
prompt	string	必填	视频内容描述，建议英文，最大 2500 字符。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），在此模型下固定为 15，默认 15
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1
image_url	string	可选	全能参考图 URL
extra_images	array	可选	参考图 URL 数组，最多 9 张
extra_videos	array	可选	参考视频 URL 数组，最多 3 个
extra_audios	array	可选	参考音频 URL 数组，最多 3 个
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-pro-15s",
  "prompt": "A cyberpunk city street at night with neon reflections, cinematic",
  "duration": 15,
  "aspect_ratio": "16:9"
}'
请求示例 · 满血多素材混合参考 (含图片、视频、音频)
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-pro-15s",
  "prompt": "Transform @Video1 into anime style, the character looks like @Image1",
  "duration": 15,
  "aspect_ratio": "16:9",
  "extra_images": [
    "https://example.com/char.jpg"
  ],
  "extra_videos": [
    "https://example.com/clip.mp4"
  ]
}'
⚠ 说明与限制

·
按次计费
·
视频时长固定 15 秒
·
相比 fast 版生成更慢，但画质与时间一致性更好
·
视频输出分辨率 720p（16:9 = 1280×720）
·
素材限制同上
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed

JA-sd2-pro-1080p
1080p · 15s
1080p 高清版 15s 固定时长，输出分辨率提升至 1080p，画面更清晰，适合对画质有严格要求的场景。

接口参数 (Payload)
参数名	类型	必填	说明
model	string	必填	固定值 JA-sd2-pro-1080p
prompt	string	必填	视频内容描述，建议英文，最大 2500 字符。引用素材时在文本中插入 @Image1 @Video1 @Audio1
duration	integer	可选	视频时长（秒），在此模型下固定为 15，默认 15
aspect_ratio	string	可选	画面比例：16:9（默认）、9:16、1:1
image_url	string	可选	全能参考图 URL
extra_images	array	可选	参考图 URL 数组，最多 9 张
extra_videos	array	可选	参考视频 URL 数组，最多 3 个
extra_audios	array	可选	参考音频 URL 数组，最多 3 个
请求示例 · 纯文本模式
cURL
复制
curl -X POST /v1/videos \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "JA-sd2-pro-1080p",
  "prompt": "A cinematic aerial shot of a futuristic city at dusk, 8k ultra detail",
  "duration": 15,
  "aspect_ratio": "16:9"
}'
⚠ 说明与限制

·
按次计费
·
视频时长固定 15 秒
·
输出分辨率为 1080p（16:9 = 1920×1080）
·
素材限制同上
·
💡 真人 / 人脸素材建议先处理（如遮挡眼睛等部位）再上传，成功率更高
·
异步任务，请持续轮询直到 completed 或 failed
