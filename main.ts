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

// --- 核心业务逻辑：调用 Gemini API（使用正确模型） ---
async function callGemini(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
  if (!apiKey) {
    throw new Error("callGemini received an empty apiKey.");
  }

  // 构造符合Gemini API要求的请求体
  const geminiPayload = {
    contents: messages,
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7
    }
  };

  console.log("Sending payload to Gemini API:", JSON.stringify(geminiPayload, null, 2));

  // 关键修正：使用官方支持的 gemini-1.5-flash 模型
  const apiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
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

  // 解析Gemini响应
  const candidate = responseData.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    throw new Error("Gemini response has no valid parts");
  }

  let imageContent = "";
  let textContent = "";
  for (const part of candidate.content.parts) {
    // 处理图像响应
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      imageContent = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
    // 处理文本响应
    if (part.text && typeof part.text === 'string' && part.text.trim()) {
      textContent += part.text.trim() + "\n";
    }
  }

  // 优先返回图像，否则返回文本
  if (imageContent) {
    return { type: 'image', content: imageContent };
  }
  if (textContent.trim()) {
    return { type: 'text', content: textContent.trim() };
  }

  return { type: 'text', content: "[模型没有返回有效内容]" };
}

// --- 主服务逻辑（与之前一致，无需修改） ---
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
      let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
      if (!apiKey) {
        return createJsonErrorResponse("API key is missing.", 401);
      }
      if (!geminiRequest.contents?.length) {
        return createJsonErrorResponse("Invalid request: 'contents' array is missing.", 400);
      }

      // 提取相关历史消息
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

      // 转换为Gemini要求的消息格式
      const geminiMessages = relevantHistory.map((msg: any) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        parts: msg.parts.map((part: any) => {
          if (part.inlineData) return { inlineData: part.inlineData };
          if (part.text) return { text: part.text.trim() };
          return part;
        })
      }));

      // 流式处理
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const sendChunk = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

          try {
            const geminiResult = await callGemini(geminiMessages, apiKey);

            // 流式返回文本
            if (geminiResult.type === 'text') {
              const text = geminiResult.content;
              for (const char of text) {
                sendChunk({
                  candidates: [{
                    content: { role: "model", parts: [{ text: char }] },
                    finishReason: null
                  }]
                });
                await new Promise(r => setTimeout(r, 2));
              }
            }

            // 返回图像
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
              usageMetadata: { promptTokenCount: 0, totalTokenCount: 0 }
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

      // 提取相关历史消息
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

      // 转换为Gemini要求的消息格式
      const geminiMessages = relevantHistory.map((msg: any) => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        parts: msg.parts.map((part: any) => {
          if (part.inlineData) return { inlineData: part.inlineData };
          if (part.text) return { text: part.text.trim() };
          return part;
        })
      }));

      // 调用Gemini API
      const geminiResult = await callGemini(geminiMessages, apiKey);

      // 构造响应
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
        usageMetadata: { promptTokenCount: 0, totalTokenCount: 0 }
      };

      return new Response(JSON.stringify(responsePayload), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });

    } catch (error: any) {
      return createJsonErrorResponse(error.message, 500);
    }
  }

  // --- 路由 3: Web UI 生成接口 ---
  if (pathname === "/generate") {
    try {
      const { prompt, images, apikey } = await req.json();
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

      // 构造Gemini消息格式
      const geminiMessages = [{
        role: "user",
        parts: [
          { text: prompt.trim() },
          ...images.map((img: string) => {
            const [mimeType, base64Data] = img.split(/data:(.+);base64,(.*)/).filter(Boolean);
            if (!mimeType || !base64Data) {
              throw new Error(`Invalid image format: ${img.slice(0, 50)}...`);
            }
            return { inlineData: { mimeType, data: base64Data } };
          })
        ]
      }];

      // 调用Gemini API
      const result = await callGemini(geminiMessages, geminiApiKey);

      // 返回结果
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
