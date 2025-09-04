// --- START OF FILE main.ts ---

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) { /* ... */ }

// --- 核心业务逻辑：调用 OpenRouter ---
async function callOpenRouter(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
    const openrouterPayload = { model: "google/gemini-2.5-flash-image-preview", messages };
    console.log("Sending SMARTLY EXTRACTED payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));
    const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(openrouterPayload)
    });
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`OpenRouter API error: Unauthorized - ${errorBody}`);
    }
    const responseData = await apiResponse.json();
    console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));
    const message = responseData.choices?.[0]?.message;
    if (message?.images?.[0]?.image_url?.url) { return { type: 'image', content: message.images[0].image_url.url }; }
    if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) { return { type: 'image', content: message.content }; }
    if (typeof message?.content === 'string' && message.content.trim() !== '') { return { type: 'text', content: message.content }; }
    return { type: 'text', content: "[模型没有返回有效内容]" };
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    if (req.method === 'OPTIONS') { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key" } }); }

    // --- 新增路由: 检查 API Key 是否已在环境变量中设置 ---
    if (pathname === "/api/key-status") {
        const isSet = !!Deno.env.get("OPENROUTER_API_KEY");
        return new Response(JSON.stringify({ isSet }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }

    // --- 路由 1: Cherry Studio (Gemini, 流式) ---
    if (pathname.includes(":streamGenerateContent")) {
        // ... (此部分代码未修改)
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
            const openrouterMessages = relevantHistory.map((geminiMsg: any) => {
                const parts = geminiMsg.parts.map((p: any) => p.text ? {type: "text", text: p.text} : {type: "image_url", image_url: {url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`}});
                return { role: geminiMsg.role === 'model' ? 'assistant' : 'user', content: parts };
            });
            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        const openRouterResult = await callOpenRouter(openrouterMessages, apiKey);
                        const sendChunk = (data: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
                        let textToStream = (openRouterResult.type === 'image') ? "好的，图片已生成：" : openRouterResult.content;
                        for (const char of textToStream) {
                            sendChunk({ candidates: [{ content: { role: "model", parts: [{ text: char }] } }] });
                            await new Promise(r => setTimeout(r, 2));
                        }
                        if (openRouterResult.type === 'image') {
                            const matches = openRouterResult.content.match(/^data:(.+);base64,(.*)$/);
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
        // ... (此部分代码未修改)
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
            const openrouterMessages = relevantHistory.map((geminiMsg: any) => {
                const parts = geminiMsg.parts.map((p: any) => p.text ? {type: "text", text: p.text} : {type: "image_url", image_url: {url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`}});
                return { role: geminiMsg.role === 'model' ? 'assistant' : 'user', content: parts };
            });
            const openRouterResult = await callOpenRouter(openrouterMessages, apiKey);
            const finalParts = [];
            if (openRouterResult.type === 'image') {
                const matches = openRouterResult.content.match(/^data:(.+);base64,(.*)$/);
                if (matches) {
                    finalParts.push({ text: "好的，图片已生成：" });
                    finalParts.push({ inlineData: { mimeType: matches[1], data: matches[2] } });
                } else {
                    finalParts.push({ text: "[图片生成失败]" });
                }
            } else {
                finalParts.push({ text: openRouterResult.content });
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
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");
            if (!openrouterApiKey) { return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500 }); }
            if (!prompt || !images || !images.length) { return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400 }); }
            
            const webUiMessages = [ { role: "user", content: [ {type: "text", text: prompt}, ...images.map(img => ({type: "image_url", image_url: {url: img}})) ] } ];
            
            const result = await callOpenRouter(webUiMessages, openrouterApiKey);
    
            // --- 这里是修改的关键 ---
            if (result.type === 'image') {
                // 成功：返回图片 URL
                return new Response(JSON.stringify({ imageUrl: result.content }), { 
                    headers: { "Content-Type": "application/json" } 
                });
            } else {
                // 失败但可重试：模型返回了文本，告知前端需要重试
                console.log(`Model returned text, signaling retry. Content: "${result.content}"`);
                return new Response(JSON.stringify({ 
                    retry: true, 
                    message: `模型返回了文本: ${result.content}` 
                }), { 
                    status: 200, // 仍然是 200 OK，但负载内容不同
                    headers: { "Content-Type": "application/json" } 
                });
            }
            
        } catch (error) {
            console.error("Error handling /generate request:", error);
            // 硬错误：直接返回错误信息给前端，不可重试
            return new Response(JSON.stringify({ error: error.message }), { 
                status: 500,
                headers: { "Content-Type": "application/json" } 
            });
        }
    }

    // --- 路由 4: 静态文件服务 ---
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});

// --- END OF FILE main.ts ---
