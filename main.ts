import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) { /* ... */ }

// --- 核心业务逻辑：调用 OpenRouter ---
async function callOpenRouter(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
    // 验证API密钥是否存在
    if (!apiKey) { 
        throw new Error("callOpenRouter received an empty apiKey."); 
    }
    
    // 定义初始模型为免费版本
    // 免费版模型: google/gemini-2.5-flash-image-preview:free
    // 非免费版模型: google/gemini-2.5-flash-image-preview
    let model = "google/gemini-2.5-flash-image-preview:free";
    
    /**
     * 封装请求逻辑，便于在模型切换时复用
     * @param currentModel 当前要使用的模型名称
     * @returns 包含响应对象和当前使用模型的结果
     */
    const makeRequest = async (currentModel: string) => {
        // 构建请求 payload，包含模型和消息列表
        const openrouterPayload = { model: currentModel, messages };
        console.log(`Sending payload to OpenRouter with model ${currentModel}:`, JSON.stringify(openrouterPayload, null, 2));
        
        // 发送POST请求到OpenRouter API
        const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST", 
            headers: { 
                "Authorization": `Bearer ${apiKey}`,  // 身份验证头
                "Content-Type": "application/json"     // 指定内容类型为JSON
            },
            body: JSON.stringify(openrouterPayload)   // 将payload转为JSON字符串
        });
        
        return { apiResponse, currentModel };
    };
    
    // 首次使用免费模型发送请求
    let { apiResponse, currentModel } = await makeRequest(model);
    
    /**
     * 检查API响应是否出错，若出错判断是否为免费额度用尽
     * 如果是免费额度用尽，自动切换到非免费模型并重试
     */
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        console.log(`OpenRouter API error with model ${currentModel}:`, errorBody);
        
        // 判断是否为免费额度用尽的情况
        // 基于OpenRouter常见错误信息特征: 包含quota(配额)和exhausted(用尽)/insufficient(不足)关键词
        // 同时确保当前使用的是免费模型
        const isFreeQuotaExhausted = errorBody.includes("quota") && 
                                    (errorBody.includes("exhausted") || errorBody.includes("insufficient")) &&
                                    currentModel.includes(":free");
        
        if (isFreeQuotaExhausted) {
            console.log("免费额度已用尽，尝试切换到非免费模型...");
            // 切换到非免费版本模型（移除:free后缀）
            const newModel = "google/gemini-2.5-flash-image-preview";
            // 使用新模型重新发起请求
            const retryResult = await makeRequest(newModel);
            apiResponse = retryResult.apiResponse;
            currentModel = newModel;
        }
    }
    
    // 检查最终请求是否成功，若仍失败则抛出详细错误
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`OpenRouter API error with model ${currentModel}: ${errorBody}`);
    }
    
    // 解析API返回的JSON数据
    const responseData = await apiResponse.json();
    console.log(`OpenRouter Response with model ${currentModel}:`, JSON.stringify(responseData, null, 2));
    
    // 提取响应中的消息内容
    const message = responseData.choices?.[0]?.message;
    
    // 处理图片类型响应
    if (message?.images?.[0]?.image_url?.url) { 
        return { type: 'image', content: message.images[0].image_url.url }; 
    }
    
    // 处理base64编码的图片内容
    if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) { 
        return { type: 'image', content: message.content }; 
    }
    
    // 处理文本类型响应
    if (typeof message?.content === 'string' && message.content.trim() !== '') { 
        return { type: 'text', content: message.content }; 
    }
    
    // 处理模型未返回有效内容的情况
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

            const openrouterMessages = relevantHistory.map((geminiMsg: any) => {
                const parts = geminiMsg.parts.map((p: any) => p.text ? {type: "text", text: p.text} : {type: "image_url", image_url: {url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`}});
                return { role: geminiMsg.role === 'model' ? 'assistant' : 'user', content: parts };
            });
            
            // --- 简化后的流处理 ---
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
            
            // --- 这里是修改的关键 ---
            const result = await callOpenRouter(webUiMessages, openrouterApiKey);
    
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
