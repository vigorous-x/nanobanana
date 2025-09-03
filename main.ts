import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) { /* ... */ }

// --- 核心业务逻辑：调用 Gemini 原生接口 ---
async function callGemini(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
    if (!apiKey) { throw new Error("callGemini received an empty apiKey."); }
    const geminiPayload = { contents: messages };
    console.log("Sending payload to Gemini API:", JSON.stringify(geminiPayload, null, 2));
    const apiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload)
    });
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`Gemini API error: Unauthorized - ${errorBody}`);
    }
    const responseData = await apiResponse.json();
    console.log("Gemini Response:", JSON.stringify(responseData, null, 2));
    const candidate = responseData.candidates?.[0]?.content;
    if (candidate?.parts?.[0]?.inlineData) {
        const { mimeType, data } = candidate.parts[0].inlineData;
        return { type: 'image', content: `data:${mimeType};base64,${data}` };
    }
    if (candidate?.parts?.[0]?.text) {
        return { type: 'text', content: candidate.parts[0].text };
    }
    return { type: 'text', content: "[模型没有返回有效内容]" };
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    if (req.method === 'OPTIONS') { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key" } }); }

    // --- 路由 1: Cherry Studio (Gemini, 流式) ---
    if (pathname.includes(":streamGenerateContent")) {
        try {
            const geminiRequest = await req.json();
            let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
            if (!apiKey) { return createJsonErrorResponse("API key is missing.", 401); }
            if (!geminiRequest.contents?.length) { return createJsonErrorResponse("Invalid request: 'contents' array is missing.", 400); }
            
            // --- 智能提取逻辑 ---
            const fullHistory = geminiRequest.contents;
            const lastUserMessageIndex = fullHistory.findLastIndex((msg: any) => msg.role === 'user');
            let relevantHistory = (lastUserMessageIndex !== -1) ? fullHistory.slice(fullHistory.findLastIndex((msg: any, idx: number) => msg.role === 'model' && idx < lastUserMessageIndex), lastUserMessageIndex + 1) : [];
            if (relevantHistory.length === 0 && lastUserMessageIndex !== -1) relevantHistory = [fullHistory[lastUserMessageIndex]];
            if (relevantHistory.length === 0) return createJsonErrorResponse("No user message found.", 400);

            // Gemini 原生接口直接用 contents
            const geminiMessages = relevantHistory;
            
            // --- 简化后的流处理 ---
            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        const geminiResult = await callGemini(geminiMessages, apiKey);
                        const sendChunk = (data: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
                        
                        let textToStream = (geminiResult.type === 'image') ? "好的，图片已生成：" : geminiResult.content;
                        for (const char of textToStream) {
                            sendChunk({ candidates: [{ content: { role: "model", parts: [{ text: char }] } }] });
                            await new Promise(r => setTimeout(r, 2));
                        }
                        
                        if (geminiResult.type === 'image') {
                            const matches = geminiResult.content.match(/^data:(.+);base64,(.*)$/);
                            if (matches) {
                                sendChunk({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: matches[1], data: matches[2] } }] } }] });
                            }
                        }
                        
                        sendChunk({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 264, totalTokenCount: 1578 } });
                        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    } catch (e) {
                        console.error("Error inside stream:", e);
                        const errorChunk = { error: { message: e.message, code: 500 } };
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                    } finally {
                        controller.close();
                    }
                }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });
        } catch (error) {
            return createJsonErrorResponse(error.message, 500);
        }
    }

    // --- 路由 2: Cherry Studio (Gemini, 非流式) ---
    if (pathname.includes(":generateContent")) {
        try {
            const geminiRequest = await req.json();
            let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
            if (!apiKey) { return createJsonErrorResponse("API key is missing.", 401); }
            if (!geminiRequest.contents?.length) { return createJsonErrorResponse("Invalid request: 'contents' array is missing.", 400); }

            const fullHistory = geminiRequest.contents;
            const lastUserMessageIndex = fullHistory.findLastIndex((msg: any) => msg.role === 'user');
            let relevantHistory = (lastUserMessageIndex !== -1) ? fullHistory.slice(fullHistory.findLastIndex((msg: any, idx: number) => msg.role === 'model' && idx < lastUserMessageIndex), lastUserMessageIndex + 1) : [];
            if (relevantHistory.length === 0 && lastUserMessageIndex !== -1) relevantHistory = [fullHistory[lastUserMessageIndex]];
            if (relevantHistory.length === 0) return createJsonErrorResponse("No user message found.", 400);

            const geminiMessages = relevantHistory;
            
            const geminiResult = await callGemini(geminiMessages, apiKey);

            const finalParts: any[] = [];
            if (geminiResult.type === 'image') {
                const matches = geminiResult.content.match(/^data:(.+);base64,(.*)$/);
                if (matches) {
                    finalParts.push({ text: "好的，图片已生成：" });
                    finalParts.push({ inlineData: { mimeType: matches[1], data: matches[2] } });
                } else {
                    finalParts.push({ text: "[图片生成失败]" });
                }
            } else {
                finalParts.push({ text: geminiResult.content });
            }
            const responsePayload = { candidates: [{ content: { role: "model", parts: finalParts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 264, totalTokenCount: 1578 } };
            return new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        } catch (error) {
            return createJsonErrorResponse(error.message, 500);
        }
    }

    // --- 路由 3: 你的 Web UI (nano banana) ---
    if (pathname === "/generate") {
        try {
            const { prompt, images, apikey } = await req.json();
            const geminiApiKey = apikey; // 不再尝试读取 Deno.env
            if (!geminiApiKey) { return new Response(JSON.stringify({ error: "Gemini API key is not set." }), { status: 500 }); }
            if (!prompt || !images || !images.length) { return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400 }); }
            
            const webUiMessages = [ { role: "user", parts: [ { text: prompt }, ...images.map(img => ({ inlineData: { mimeType: img.split(';')[0].replace('data:', ''), data: img.split(',')[1] } })) ] } ];
            
            // --- 这里是修改的关键 ---
            const result = await callGemini(webUiMessages, geminiApiKey);
    
            // 检查返回的是否是图片类型，并提取 content
            if (result && result.type === 'image') {
                // 返回给前端正确的 JSON 结构
                return new Response(JSON.stringify({ imageUrl: result.content }), { 
                    headers: { "Content-Type": "application/json" } 
                });
            } else {
                // 如果模型意外地返回了文本或其他内容，则返回错误
                const errorMessage = result ? `Model returned text instead of an image: ${result.content}` : "Model returned an empty response.";
                console.error("Error handling /generate request:", errorMessage);
                return new Response(JSON.stringify({ error: errorMessage }), { 
                    status: 500, 
                    headers: { "Content-Type": "application/json" } 
                });
            }
            
        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }

    // --- 路由 4: 静态文件服务 ---
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
