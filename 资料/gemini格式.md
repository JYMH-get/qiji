Gemini 对接文档
支持 Gemini 原生 v1beta 接口，适合 Gemini SDK、Gemini CLI 或直接 REST 调用。流式输出使用 streamGenerateContent?alt=sse。

认证方式
Authorization: Bearer sk-...
模型调用接口均使用 API 密钥认证；请在 API 密钥页创建并绑定对应平台分组。
当前支持模型
模型	类型	推荐接口	说明
gemini-3-pro-image-preview	图片	/v1beta/models/{model}:generateContent	香蕉 Pro
gemini-3.1-flash-image-preview	图片	/v1beta/models/{model}:generateContent	香蕉 2
POST
/v1beta/models/{model}:generateContent
Gemini Generate Content
Gemini 原生非流式接口。模型名放在 URL path 中，body 使用 contents/systemInstruction/generationConfig。

复制示例
参数
contents*	Gemini contents 数组，parts 可包含 text、inlineData 等。
systemInstruction	系统指令，格式为 { parts: [{ text }] }。
generationConfig.temperature	采样温度。
generationConfig.maxOutputTokens	最大输出 token。
generationConfig.responseModalities	图片模型可设置 ["TEXT","IMAGE"]。
generationConfig.imageConfig	图片模型配置，例如 aspectRatio、imageSize。
认证：Authorization: Bearer <API_KEY>
请求示例
复制
curl "https://sub.g-aisc.com/v1beta/models/gemini-3-pro-image-preview:generateContent" \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "用一句话介绍 G-AISC"
        }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 512
  }
}'
POST
/v1beta/models/{model}:streamGenerateContent?alt=sse
Gemini Stream Generate Content
Gemini 原生流式接口，返回 SSE。适合 CLI、长文本生成和需要边生成边显示的场景。

复制示例
参数
contents*	Gemini contents 数组。
alt=sse*	开启 SSE 流式输出。
generationConfig	同 generateContent。
认证：Authorization: Bearer <API_KEY>
请求示例
复制
curl "https://sub.g-aisc.com/v1beta/models/gemini-3-pro-image-preview:streamGenerateContent?alt=sse" \
  -H "Authorization: Bearer sk-xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "写一个简短的接口调用示例"
        }
      ]
    }
  ]
}'