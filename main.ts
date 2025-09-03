import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status: statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// --- 核心业务逻辑：调用 Gemini API（修正函数名与功能匹配） ---
async function callGemini(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
  if (!apiKey) {
    throw new Error("callGemini received an empty apiKey.");
  }

  // 关键修正：按 Gemini API 要求构造请求体
  // messages 已是 { role: string; parts: Array<{ text?: string; inlineData?: {...} }> } 格式，无需额外转换
  const geminiPayload = {
    contents: messages, // 直接使用正确格式的 messages，无需嵌套转换
    generationConfig: {
      responseMimeType: "application/json" // 确保响应格式可解析
    }
  };

  console.log("Sending payload to Gemini API:", JSON.stringify(geminiPayload, null, 2));

  // 调用 Gemini API（使用 2.5 Flash 图像预览模型）
  const apiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    }
  );

  if (!apiResponse.ok) {
    const errorBody = await apiResponse.text();
    throw new Error(`Gemini API error: ${apiResponse.statusText} - ${errorBody}`);
  }

  const responseData = await apiResponse.json();
  console.log("Gemini Response:", JSON.stringify(responseData, null, 2));

  // 解析 Gemini 响应（处理文本/图像输出）
  const candidate = responseData.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    throw new Error("Gemini response has no valid parts");
  }

  // 遍历 parts，优先处理图像，再处理文本
  let imageContent = "";
  let textContent = "";
  for (const part of candidate.content.parts) {
    // 图像响应：Gemini 图像输出在 inlineData 中
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      imageContent = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
    // 文本响应：直接提取 text 字段
    if (part.text && typeof part.text === 'string' && part.text.trim()) {
      textContent += part.text.trim() + "\n";
    }
  }

  // 优先返回图像（若有），否则返回文本
  if (imageContent) {
    return { type: 'image', content: imageContent };
  }
  if (textContent.trim()) {
    return { type: 'text', content: textContent.trim() };
  }

  return { type: 'text', content: "[模型没有返回有效内容]" };
}

// --- 主服务逻辑 ---
serve(async (req) => {
  const pathname = new URL(req.url).pathname;
  
  // 处理跨域预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key"
      }
    });
  }

  // --- 路由 1: Cherry Studio (Gemini, 流式) ---
  if (pathname.includes(":streamGenerateContent")) {
    try {
      const geminiRequest = await req.json();
      // 提取 API Key（支持 Bearer Token 或 x-goog-api-key 头）
      let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
      if (!apiKey) {
        return createJsonErrorResponse("API key is missing.", 401);
      }
      if (!geminiRequest.contents?.length) {
        return createJsonErrorResponse("Invalid request: 'contents' array is missing.", 400);
      }

      // --- 智能提取逻辑（修正：保留 Gemini 原生 parts 格式） ---
      const fullHistory = geminiRequest.contents;
      const lastUserMessageIndex = fullHistory.findLastIndex((msg: any) => msg.role === 'user');
      let relevantHistory = [];
      if (lastUserMessageIndex !== -1) {
        // 提取最后一条用户消息前的最近一条模型消息到当前用户消息
        const lastModelMsgIndex = fullHistory.findLastIndex((msg: any, idx: number) => msg.role === 'model' && idx < lastUserMessageIndex);
        relevantHistory = fullHistory.slice(lastModelMsgIndex === -1 ? 0 : lastModelMsgIndex, lastUserMessageIndex + 1);
      }
      if (relevantHistory.length === 0) {
        return createJsonErrorResponse("No user message found.", 400);
      }

      // --- 关键修正：不转换为 OpenRouter 格式，直接使用 Gemini 原生格式 ---
      // 仅修正 role 映射（Gemini 的 'model' 对应 API 要求的 'assistant'）
      const geminiMessages = relevantHistory.map((msg: any) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role, // 角色映射
        parts: msg.parts.map((part: any) => {
          // 处理图像输入：将 Gemini 请求的 inlineData 转为 API 要求格式
          if (part.inlineData) {
            return { inlineData: part.inlineData };
          }
          // 处理文本输入：直接返回 { text: ... }，不添加 type 字段
          if (part.text && typeof part.text === 'string') {
            return { text: part.text.trim() };
          }
          return part;
        })
      }));

      // --- 流式处理逻辑 ---
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const sendChunk = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

          try {
            const geminiResult = await callGemini(geminiMessages, apiKey);

            // 流式返回文本（逐字符模拟流）
            if (geminiResult.type === 'text') {
              const text = geminiResult.content;
              for (const char of text) {
                sendChunk({
                  candidates: [{
                    content: { role: "model", parts: [{ text: char }] },
                    finishReason: null
                  }]
                });
                await new Promise(r => setTimeout(r, 2)); // 模拟流延迟
              }
            }

            // 返回图像（若有）
            if (geminiResult.type === 'image') {
              const [mimeType, base64Data] = geminiResult.content.split(/data:(.+);base64,(.*)/).filter(Boolean);
              sendChunk({
                candidates: [{
                  content: {
                    role: "model",
                    parts: [{ inlineData: { mimeType, data: base64Data } }]
                  },
                  finishReason: null
                }]
              });
            }

            // 流结束标记
            sendChunk({
              candidates: [{
                content: { role: "model", parts: [] },
                finishReason: "STOP"
              }],
              usageMetadata: { promptTokenCount: 0, totalTokenCount: 0 } // 实际项目可从 Gemini 响应提取真实 Token 数
            });
            sendChunk({ done: true });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));

          } catch (e: any) {
            console.error("Stream error:", e);
            sendChunk({ error: { message: e.message, code: 500 } });
          } finally {
            controller.close();
          }
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (error: any) {
      return createJsonErrorResponse(error.message, 500);
    }
  }

  // --- 路由 2: Cherry Studio (Gemini, 非流式) ---
  if (pathname.includes(":generateContent")) {
    try {
      const geminiRequest = await req.json();
      let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
      if (!apiKey) {
        return createJsonErrorResponse("API key is missing.", 401);
      }
      if (!geminiRequest.contents?.length) {
        return createJsonErrorResponse("Invalid request: 'contents' array is missing.", 400);
      }

      // --- 智能提取逻辑（同流式，保留 Gemini 原生格式） ---
      const fullHistory = geminiRequest.contents;
      const lastUserMessageIndex = fullHistory.findLastIndex((msg: any) => msg.role === 'user');
      let relevantHistory = [];
      if (lastUserMessageIndex !== -1) {
        const lastModelMsgIndex = fullHistory.findLastIndex((msg: any, idx: number) => msg.role === 'model' && idx < lastUserMessageIndex);
        relevantHistory = fullHistory.slice(lastModelMsgIndex === -1 ? 0 : lastModelMsgIndex, lastUserMessageIndex + 1);
      }
      if (relevantHistory.length === 0) {
        return createJsonErrorResponse("No user message found.", 400);
      }

      // --- 关键修正：使用 Gemini 原生格式构造消息 ---
      const geminiMessages = relevantHistory.map((msg: any) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        parts: msg.parts.map((part: any) => {
          if (part.inlineData) return { inlineData: part.inlineData };
          if (part.text) return { text: part.text.trim() };
          return part;
        })
      }));

      // 调用 Gemini API
      const geminiResult = await callGemini(geminiMessages, apiKey);

      // 构造 Gemini 风格的响应
      const finalParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (geminiResult.type === 'image') {
        const [mimeType, base64Data] = geminiResult.content.split(/data:(.+);base64,(.*)/).filter(Boolean);
        if (mimeType && base64Data) {
          finalParts.push({ text: "好的，图片已生成：" });
          finalParts.push({ inlineData: { mimeType, data: base64Data } });
        } else {
          finalParts.push({ text: "[图片生成失败]" });
        }
      } else {
        finalParts.push({ text: geminiResult.content });
      }

      const responsePayload = {
        candidates: [{
          content: { role: "model", parts: finalParts },
          finishReason: "STOP",
          index: 0
        }],
        usageMetadata: { promptTokenCount: 0, totalTokenCount: 0 } // 实际项目可替换为真实 Token 数
      };

      return new Response(JSON.stringify(responsePayload), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (error: any) {
      return createJsonErrorResponse(error.message, 500);
    }
  }

  // --- 路由 3: 你的 Web UI (nano banana) ---
  if (pathname === "/generate") {
    try {
      const { prompt, images, apikey } = await req.json();
      // 提取 API Key（支持请求体传入或环境变量）
      const geminiApiKey = apikey || Deno.env.get("GEMINI_API_KEY");
      if (!geminiApiKey) {
        return new Response(JSON.stringify({ error: "Gemini API key is not set." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
      if (!prompt || !images || !images.length) {
        return new Response(JSON.stringify({ error: "Prompt and images are required." }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // --- 关键修正：构造 Gemini 原生格式的消息 ---
      const geminiMessages = [{
        role: "user",
        parts: [
          { text: prompt.trim() }, // 文本部分：直接 { text: ... }
          ...images.map((img: string) => {
            // 处理图像输入：从 dataURL 提取 mimeType 和 base64 数据
            const [mimeType, base64Data] = img.split(/data:(.+);base64,(.*)/).filter(Boolean);
            if (!mimeType || !base64Data) {
              throw new Error(`Invalid image format: ${img.slice(0, 50)}...`);
            }
            return { inlineData: { mimeType, data: base64Data } }; // 图像部分：{ inlineData: ... }
          })
        ]
      }];

      // 调用 Gemini API
      const result = await callGemini(geminiMessages, geminiApiKey);

      // 返回 Web UI 所需格式
      if (result.type === 'image') {
        return new Response(JSON.stringify({ imageUrl: result.content }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } else {
        const errorMessage = `Model returned text instead of an image: ${result.content.slice(0, 100)}...`;
        console.error("Generate route error:", errorMessage);
        return new Response(JSON.stringify({ error: errorMessage }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

    } catch (error: any) {
      console.error("Generate route error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }

  // --- 路由 4: 静态文件服务 ---
  return serveDir(req, {
    fsRoot: "static",
    urlRoot: "",
    showDirListing: true,
    enableCors: true
  });
});
