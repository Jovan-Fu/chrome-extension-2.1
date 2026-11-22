// ── 所有消息统一在同一个监听器里处理 ────────────────────────────────────
// Chrome MV3 规则：只要其中一个 if 分支返回 true，通道才保持开放。
// 多个独立监听器时，第一个不认识的 action 就会关闭通道，后续监听器无法响应。
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {

  // ── 截图 ────────────────────────────────────────────────────────────
  if (request.action === "captureTab") {
    try {
      chrome.tabs.captureVisibleTab({ format: "png" }, function(dataUrl) {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (!dataUrl) {
          sendResponse({ success: false, error: "截图数据为空" });
          return;
        }
        sendResponse({ success: true, dataUrl: dataUrl });
      });
    } catch (err) {
      sendResponse({ success: false, error: "捕获异常：" + err.toString() });
    }
    return true;
  }

  // ── 上传到 Google Apps Script ────────────────────────────────────────
  if (request.action === "uploadToGAS") {
    try {
      fetch(request.gasUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.payload)
      })
      .then(async function(response) {
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          if (text.includes("<!DOCTYPE") || text.includes("<html")) {
            return {
              status: "error",
              message: "Google 拦截了请求（返回网页）：请检查 1. GAS 部署权限是否设为「所有人（Anyone）」；2. 链接末尾是否为 /exec；3. GAS 是否需要重新授权"
            };
          }
          return { status: "error", message: "服务端异常返回：" + text.substring(0, 100) };
        }
      })
      .then(function(data) { sendResponse(data); })
      .catch(function(err) { sendResponse({ status: "error", message: err.message || err.toString() }); });
    } catch (err) {
      sendResponse({ status: "error", message: "网络请求异常：" + err.toString() });
    }
    return true;
  }

  // ── 翻译 ─────────────────────────────────────────────────────────────
  // 无 Groq Key → Google Translate 免费接口（无需注册，自动检测语言）
  // 有 Groq Key → Groq API（AI 翻译，可选升级，申请：console.groq.com）
  if (request.action === "translateText") {
    const rawText = (request.text    || "").trim();
    const groqKey = (request.groqKey || "").trim();

    if (!rawText) { sendResponse({ success: false }); return true; }

    // ── OCR 断行清理 ──────────────────────────────────────────────────
    // OCR 输出的换行是屏幕视觉断行，不是真正的段落分隔。
    // 处理规则：单个 \n → 空格（同一段内的断行合并）；\n\n → 保留（段落分隔）
    const text = rawText
      .replace(/\r\n/g, "\n")         // 统一换行符
      .replace(/\n{3,}/g, "\n\n")     // 连续多空行 → 最多两个
      .split("\n\n")                  // 按段落切分
      .map(para => para.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");                  // 段落间保留空行

    if (groqKey) {
      // ── Groq AI 翻译 ──────────────────────────────────────────────
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + groqKey
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: "你是专业翻译。将用户发送的文字**整体**翻译为中文，理解完整语义后再输出，不要逐行翻译，保持自然流畅。只返回翻译结果，不要任何解释、前缀或额外内容。"
            },
            { role: "user", content: text }
          ],
          temperature: 0.2,
          max_tokens: 2048
        })
      })
      .then(r => r.json())
      .then(data => {
        const zh = data.choices?.[0]?.message?.content?.trim();
        if (zh) {
          sendResponse({ success: true, zh });
        } else {
          // Groq 失败时降级到 Google Translate
          fallbackGoogleTranslate(text, sendResponse);
        }
      })
      .catch(() => fallbackGoogleTranslate(text, sendResponse));

    } else {
      // ── Google Translate 免费接口（默认，无需 Key）───────────────
      fallbackGoogleTranslate(text, sendResponse);
    }

    return true; // 保持异步通道
  }

  // ── OCR：OCR.Space API ──────────────────────────────────────────────
  // 免费公共测试 Key：helloworld（仅支持 Engine 1）
  // 注册免费专属 Key：https://ocr.space/ocrapi/freekey（支持 Engine 2，准确率更高）
  if (request.action === "recognizeText") {
    const { imageBase64, apiKey } = request;
    const key = (apiKey && apiKey.trim()) ? apiKey.trim() : "helloworld";

    const base64Full = imageBase64.startsWith("data:")
      ? imageBase64
      : "data:image/jpeg;base64," + imageBase64;

    // 封装单次 OCR 请求（支持指定 Engine）
    function doOCR(engine) {
      const fd = new FormData();
      fd.append("base64Image",       base64Full);
      fd.append("apikey",            key);
      fd.append("language",          "eng");
      fd.append("isOverlayRequired", "false");
      fd.append("detectOrientation", "true");
      fd.append("scale",             "true");
      fd.append("OCREngine",         String(engine));
      return fetch("https://api.ocr.space/parse/image", {
        method: "POST",
        headers: { "apikey": key },
        body: fd
      }).then(r => {
        if (r.status === 429) {
          throw new Error("429: 请求过于频繁");
        }
        return r.json();
      });
    }

    // 优先 Engine 选择：helloworld → 直接用 1；有注册 Key → 先试 2，失败降级到 1
    const preferred = (key === "helloworld") ? 1 : 2;

    doOCR(preferred)
      .then(data => {
        console.log("[OCR] engine=" + preferred + " response:", JSON.stringify(data).substring(0, 300));

        // Engine 2 失败或无结果时自动降级到 Engine 1
        const isEmpty = !data.ParsedResults || data.ParsedResults.length === 0 ||
                        data.ParsedResults.every(r => !(r.ParsedText || "").trim());
        if (preferred === 2 && (data.IsErroredOnProcessing || isEmpty)) {
          console.log("[OCR] Engine 2 失败，自动降级到 Engine 1 重试...");
          return doOCR(1);
        }
        return data;
      })
      .then(data => {
        console.log("[OCR] final response:", JSON.stringify(data).substring(0, 300));

        if (data.IsErroredOnProcessing) {
          const errMsg = (data.ErrorMessage && data.ErrorMessage[0]) || "识别失败";
          sendResponse({ success: false, error: "OCR 错误：" + errMsg });
          return;
        }

        const results = data.ParsedResults;
        if (!results || results.length === 0) {
          sendResponse({ success: true, text: "", empty: true });
          return;
        }

        const text = results
          .map(r => (r.ParsedText || "").trim())
          .filter(Boolean)
          .join("\n")
          .trim();

        if (!text) {
          sendResponse({ success: true, text: "", empty: true });
          return;
        }

        // 更新本地使用计数
        const monthKey = new Date().getFullYear() + "-" +
          String(new Date().getMonth() + 1).padStart(2, "0");

        chrome.storage.local.get(["ocrUsed", "ocrMonth", "ocrLimit"], (d) => {
          let used    = (d.ocrMonth === monthKey) ? (d.ocrUsed || 0) : 0;
          const limit = d.ocrLimit || 25000;
          used++;
          chrome.storage.local.set({ ocrUsed: used, ocrMonth: monthKey });
          sendResponse({
            success:   true,
            text,
            ocrUsed:   used,
            ocrLimit:  limit,
            ocrRemain: Math.max(limit - used, 0)
          });
        });
      })
      .catch(err => {
        console.error("[OCR] 网络错误:", err);
        const errMsg = err.toString();
        if (errMsg.includes("429")) {
          sendResponse({
            success: false,
            error: "OCR 过于频繁(429)：请等10秒后再试；若未配置专属Key，请在「🔍 OCR/AI」中填入"
          });
        } else {
          sendResponse({ success: false, error: "网络错误：" + errMsg });
        }
      });

    return true; // 保持异步通道
  }

  // ── 语音识别（视频台词转换）：Groq Whisper API ───────────────────────
  if (request.action === "transcribeAudio") {
    const groqKey = (request.groqKey || "").trim();
    if (!groqKey) {
      sendResponse({ success: false, error: "未配置 Groq Key，请在插件「🔍 OCR/AI」标签页填写" });
      return true;
    }
    if (!request.audioBase64) {
      sendResponse({ success: false, error: "音频数据为空" });
      return true;
    }

    try {
      const base64Data = request.audioBase64.split("base64,").pop();
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const audioBlob = new Blob([byteArray], { type: request.mimeType || "audio/webm" });

      const formData = new FormData();
      formData.append("file", audioBlob, "video_audio.webm");
      formData.append("model", "whisper-large-v3-turbo");
      formData.append("response_format", "verbose_json");
      formData.append("temperature", "0");

      fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + groqKey
        },
        body: formData
      })
      .then(r => r.json())
      .then(data => {
        if (data.text) {
          sendResponse({ success: true, text: data.text.trim(), language: data.language || "" });
        } else {
          const errMsg = data.error?.message || JSON.stringify(data);
          sendResponse({ success: false, error: "Whisper 识别失败：" + errMsg });
        }
      })
      .catch(err => sendResponse({ success: false, error: "语音识别网络异常：" + err.toString() }));
    } catch(err) {
      sendResponse({ success: false, error: "音频解析失败：" + err.toString() });
    }

    return true; // 保持异步通道
  }

  // ── 获取当前标签页音频流 ID（用于 tabCapture 音频捕获兜底）──────────────
  if (request.action === "getTabStreamId") {
    if (chrome.tabCapture && chrome.tabCapture.getMediaStreamId) {
      chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, streamId });
        }
      });
    } else {
      sendResponse({ success: false, error: "环境不支持 tabCapture" });
    }
    return true;
  }

});

// ── Google Translate 免费接口辅助函数 ────────────────────────────────────
// 使用 translate.googleapis.com/translate_a/single（无需 Key，自动检测语言，翻译为中文）
// 长文本按 1000 字符分段，顺序请求后拼合，避免 URL 过长
function fallbackGoogleTranslate(text, sendResponse) {
  const CHUNK = 1000;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    chunks.push(text.substring(i, i + CHUNK));
  }

  (function nextChunk(idx, acc) {
    if (idx >= chunks.length) {
      const zh = acc.join("").trim();
      sendResponse(zh ? { success: true, zh } : { success: false });
      return;
    }
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" +
                encodeURIComponent(chunks[idx]);
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const part = data[0].map(item => item[0] || "").join("");
        nextChunk(idx + 1, acc.concat(part));
      })
      .catch(() => nextChunk(idx + 1, acc.concat(chunks[idx]))); // 失败时保留原文
  })(0, []);
}

