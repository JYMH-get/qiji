Anthropic 对接文档
支持 Anthropic Messages 兼容接口，适合 Claude Code、Claude SDK 或使用 /v1/messages 的客户端。

认证方式
Authorization: Bearer sk-...
模型调用接口均使用 API 密钥认证；请在 API 密钥页创建并绑定对应平台分组。
当前支持模型
模型	类型	推荐接口	说明
claude-haiku-4-5-20251001	文本	/v1/messages	当前支持
claude-opus-4-6	文本	/v1/messages	当前支持
claude-opus-4-7	文本	/v1/messages	当前支持
claude-sonnet-4-6	文本	/v1/messages	当前支持
POST
/v1/messages
Anthropic Messages
Anthropic Messages 兼容接口，支持 system、messages、tools、thinking、cache_control 等常见 Claude 调用参数。

复制示例
参数
model*	Claude 模型 ID。
messages*	Anthropic messages 数组，role 为 user 或 assistant。
max_tokens*	最大输出 token。
system	系统提示词，支持字符串或 text block 数组。
tools / tool_choice	工具调用配置。
thinking	扩展思考配置：enabled、adaptive、disabled。
stream	是否 SSE 流式返回。
认证：Authorization: Bearer <API_KEY>
请求示例
复制
curl https://sub.g-aisc.com/v1/messages \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 512,
  "messages": [
    {
      "role": "user",
      "content": "用一句话介绍 G-AISC"
    }
  ]
}'
POST
/v1/messages/count_tokens
Anthropic Token 计数
Claude/Anthropic 平台支持 token 计数。OpenAI 分组调用此接口会返回不支持。

复制示例
参数
model*	Claude 模型 ID。
messages*	要计数的消息。
认证：Authorization: Bearer <API_KEY>
请求示例
复制
curl https://sub.g-aisc.com/v1/messages/count_tokens \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "claude-haiku-4-5-20251001",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}'