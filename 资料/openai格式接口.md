OpenAI 对接文档
支持 OpenAI Chat Completions、Responses、图片兼容接口和 Codex Images 直连接口。文本模型建议优先使用 /v1/responses 或 /v1/chat/completions，图片兼容调用使用 /v1/images/generations 或 /v1/images/edits，Codex 官方新图片格式可直接调用 /backend-api/codex/images/generations 或 /backend-api/codex/images/edits。

认证方式
Authorization: Bearer sk-...
模型调用接口均使用 API 密钥认证；请在 API 密钥页创建并绑定对应平台分组。
当前支持模型
模型	类型	推荐接口	说明
gpt-5.3-codex	文本	/v1/chat/completions 或 /v1/responses	当前支持
gpt-5.4	文本	/v1/chat/completions 或 /v1/responses	当前支持
gpt-5.4-mini	文本	/v1/chat/completions 或 /v1/responses	当前支持
gpt-5.5	文本	/v1/chat/completions 或 /v1/responses	当前支持
gpt-image-2	图片	/v1/images/generations	当前支持
POST
/v1/chat/completions
OpenAI Chat Completions
OpenAI 兼容聊天接口，适合 ChatBox、OpenCat、LangChain、OpenAI SDK 等客户端。

复制示例
参数
model*	模型 ID。请从本页当前平台模型列表中选择。
stream	是否流式返回。true 使用 SSE。
temperature	采样温度。推理模型可能会自动忽略或由上游限制。
top_p	核采样参数。
messages*	OpenAI messages 数组，支持 system/user/assistant/tool。多模态文本模型可使用 image_url。
max_tokens	最大输出 token；也兼容 max_completion_tokens。
tools / tool_choice	函数工具调用。旧版 functions / function_call 也兼容。
reasoning_effort	推理强度：low、medium、high、xhigh。
service_tier	服务层级：priority、flex 等；无效值会被清理。
认证：Authorization: Bearer <API_KEY>
请求示例
复制
curl https://sub.g-aisc.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "gpt-5.3-codex",
  "messages": [
    {
      "role": "user",
      "content": "用一句话介绍 G-AISC"
    }
  ],
  "max_tokens": 512,
  "stream": false
}'
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }


POST
/v1/images/generations
image2 图片生成 - 返回 URL
主营 image2 图片生成接口。response_format=url 会把生成结果保存到平台海外对象存储，并返回可访问 URL。URL 返回能力已开始公测，适合网页展示、异步任务、下载保存和避免大体积 base64 响应阻塞。稳定对象存储 URL 请使用非流式请求（stream=false 或不传 stream）；stream=true 的图片事件可能仍包含 base64 / data URL，不建议作为稳定 URL 返回链路。生成链接按平台说明 24 小时内有效，响应只返回 data[].url，不额外返回 expires_at 字段。平台会保护用户图片隐私。

复制示例
参数
model*	图片模型，例如当前支持的 gpt-image-2。
prompt*	图片生成提示词。
size	图片尺寸。当前计费支持 1K、2K、4K 档位，例如 1024x1024、2048x2048、3840x2160、2160x3840。
response_format*	填写 url。返回 data[].url，链接 24 小时有效。
stream	需要稳定对象存储 URL 时请传 false 或不传。stream=true 当前不作为 URL 返回推荐模式。
quality / background / output_format	OpenAI 原生图片参数，按上游模型能力透传。
n	生成图片数量；按上游模型能力和平台策略执行。
认证：Authorization: Bearer <API_KEY>。仅 OpenAI 平台图片模型支持。


POST
/v1/images/edits
image2 图片编辑 - 输入 URL / 返回 URL
主营 image2 图片编辑接口。JSON 模式可传 images[].image_url 和 mask.image_url。URL 参数的处理逻辑是：平台先校验 URL 安全性，再由 G-AISC 服务器主动下载用户提供的图片，上传到平台海外对象存储，最后把海外对象存储 URL 传给 OpenAI 上游。这样可以避免 OpenAI 直接拉取国内链接时出现网络慢、跨境不稳定或超时。输入 URL 中转与返回 URL 已开始公测，欢迎广大用户尝试并反馈；稳定对象存储 URL 请使用非流式请求（stream=false 或不传 stream）。返回 URL 按平台说明 24 小时内有效，响应只返回 data[].url，不额外返回 expires_at 字段。平台会保护用户隐私。

复制示例
参数
model*	图片模型，例如 gpt-image-2。
prompt*	编辑指令。
images[].image_url*	JSON 模式下的输入图片 URL。平台会先校验 URL，再下载图片并上传到海外对象存储，然后把中转后的海外 URL 发给 OpenAI，降低上游拉取国内链接超时概率。
mask.image_url	可选遮罩图片 URL；处理逻辑同 images[].image_url，也会先下载、中转，再提交给上游。
size	输出尺寸，支持 1K、2K、4K 档位。
response_format*	填写 url。返回 24 小时有效的对象存储链接。
stream	需要稳定对象存储 URL 时请传 false 或不传。stream=true 当前不作为 URL 返回推荐模式。
认证：Authorization: Bearer <API_KEY>。支持 JSON image_url 或 multipart image 文件。
请求示例
复制
curl https://sub.g-aisc.com/v1/images/edits \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "gpt-image-2",
  "prompt": "把背景改成干净的白色摄影棚",
  "images": [
    {
      "image_url": "https://example.cn/input.png"
    }
  ],
  "size": "2048x2048",
  "response_format": "url"
}'
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://media.g-aisc.com/uploads/outputs/..."
    }
  ]
}
POST
/v1/images/edits
image2 图片编辑 - multipart 上传
multipart 模式适合用户本地图片或私有图片文件。image 字段上传源图，mask 字段可上传遮罩图；返回格式仍由 response_format 决定。需要前端直接上传文件时，推荐 multipart；需要服务端传已有公网图片时，推荐 JSON image_url。

复制示例
参数
model*	图片模型，例如 gpt-image-2。
prompt*	编辑指令。
image*	multipart 文件字段，可重复传多个 image。
mask	可选 multipart 遮罩文件。
response_format	url 或 b64_json。大图、网页展示和批量任务建议 url；本地私有处理可用 b64_json。
认证：Authorization: Bearer <API_KEY>。适合本地文件上传，不需要先把图片放到公网。
请求示例
复制
curl https://sub.g-aisc.com/v1/images/edits \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -F "model=gpt-image-2" \
  -F "prompt=把背景改成干净的白色摄影棚" \
  -F "image=@/path/to/input.png" \
  -F "size=2048x2048" \
  -F "response_format=url"
指南
response_format=url / b64_json
image2 返回格式选择
url 和 b64_json 都支持，按业务场景选择。url 模式响应小、速度更稳定，适合 2K/4K、网页展示、移动端、批量任务和避免用户长时间等待；b64_json 不依赖临时链接，适合后端即时转存、私有链路或调用方必须接收 base64 的老系统。

复制示例
参数
url 优先场景	4K 图片、批量生成、浏览器展示、移动端展示、回调/队列任务、用户反馈 base64 返回慢。链接 24 小时有效。
b64_json 优先场景	调用方必须直接拿图片字节、需要立即写入自己的对象存储、不能接受临时 URL。
流式说明	需要平台对象存储 URL 时，请使用非流式请求。stream=true 更适合进度感知，事件中可能包含 base64 / data URL，不建议依赖它拿最终对象存储链接。
输入 URL 中转	编辑接口传图片 URL 时，平台会先做 URL 安全校验，然后由 G-AISC 服务器下载图片，上传到海外对象存储，再把海外 URL 传给 OpenAI。这样可以减少 OpenAI 直接下载国内 URL 导致的超时。若原始 URL 无法访问、下载超时、文件过大或不是有效图片，请求可能返回图片 URL 拉取失败。
隐私说明	平台仅为完成图片请求和 24 小时临时访问保存必要文件，不会把用户图片作为公开素材展示。
认证方式同图片生成/编辑接口。URL 模式为公测能力，欢迎反馈异常样例。
