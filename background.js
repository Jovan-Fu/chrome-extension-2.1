// 消息统一校验后分派；同步返回 true 以保留异步响应通道。
const SUPPORTED_HOSTS = ["facebook.com", "youtube.com", "instagram.com", "tiktok.com",
  "pinterest.com", "pinterest.co.uk", "behance.net", "dribbble.com", "flickr.com"];

function isTrustedSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && SUPPORTED_HOSTS.some(host =>
      url.hostname === host || url.hostname.endsWith("." + host));
  } catch { return false; }
}

function isGASUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://script.google.com" && !url.username && !url.password &&
      !url.search && !url.hash && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname);
  } catch { return false; }
}

function validRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
  switch (request.action) {
    case "captureTab": case "getTabStreamId": case "getAIConfig": return true;
    case "translateText": return bounded(request.text, 50000);
    case "recognizeText": return bounded(request.imageBase64, 14 * 1024 * 1024) &&
      /^(?:data:image\/(?:jpeg|png);base64,)?[A-Za-z0-9+/]+={0,2}$/.test(request.imageBase64);
    case "transcribeAudio": return bounded(request.audioBase64, 34 * 1024 * 1024) &&
      /^data:audio\/(?:webm|ogg|mp4|mpeg|wav)(?:;codecs=[a-z0-9,.-]+)?;base64,[A-Za-z0-9+/]+={0,2}$/i.test(request.audioBase64);
    case "uploadToGAS": return isGASUrl(request.gasUrl) && request.payload &&
      typeof request.payload === "object" && !Array.isArray(request.payload) &&
      JSON.stringify(request.payload).length <= 15 * 1024 * 1024;
    default: return false;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000),
    credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("服务请求失败（HTTP " + response.status + "）");
  return response;
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (!isTrustedSender(sender) || !validRequest(request)) {
    sendResponse({ success: false, status: "error", error: "请求来源或参数无效" });
    return false;
  }
  chrome.storage.local.get(["gasUrl", "sheetId", "folderId", "sheetName", "visionKey", "groqKey"], cfg => {
    if (chrome.runtime.lastError) {
      sendResponse({ success: false, status: "error", error: "读取配置失败" });
      return;
    }
    if (request.action === "getAIConfig") {
      sendResponse({ hasGroqKey: typeof cfg.groqKey === "string" && !!cfg.groqKey.trim() });
      return;
    }
    if (request.action === "uploadToGAS") {
      if (request.gasUrl !== cfg.gasUrl || !isGASUrl(cfg.gasUrl)) {
        sendResponse({ status: "error", message: "上传地址与已配置的 GAS 地址不一致" });
        return;
      }
      request = { ...request, payload: { ...request.payload,
        sheetId: cfg.sheetId, folderId: cfg.folderId, sheetName: cfg.sheetName || "" } };
    }
    try {
      handleRequest({ ...request, groqKey: typeof cfg.groqKey === "string" ? cfg.groqKey : "",
        apiKey: typeof cfg.visionKey === "string" ? cfg.visionKey : "" }, sender, sendResponse);
    } catch {
      sendResponse({ success: false, status: "error", error: "请求处理失败" });
    }
  });
  return true;
});

function handleRequest(request, sender, sendResponse) {

  // ── 截图 ────────────────────────────────────────────────────────────
  if (request.action === "captureTab") {
    try {
      chrome.tabs.query({ active: true, windowId: sender.tab.windowId }, function(tabs) {
        if (chrome.runtime.lastError || tabs[0]?.id !== sender.tab.id || tabs[0]?.url !== sender.url) {
          sendResponse({ success: false, error: "请保持发起截图的页面处于当前窗口的活动标签" });
          return;
        }
        chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, function(dataUrl) {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!dataUrl) {
            sendResponse({ success: false, error: "截图数据为空" });
            return;
          }
          chrome.tabs.query({ active: true, windowId: sender.tab.windowId }, function(currentTabs) {
            if (chrome.runtime.lastError || currentTabs[0]?.id !== sender.tab.id || currentTabs[0]?.url !== sender.url) {
              sendResponse({ success: false, error: "截图期间标签页发生变化，请重试" });
              return;
            }
            sendResponse({ success: true, dataUrl: dataUrl });
          });
        });
      });
    } catch (err) {
      sendResponse({ success: false, error: "捕获异常：" + err.toString() });
    }
    return true;
  }

  // ── 上传到 Google Apps Script ────────────────────────────────────────
  if (request.action === "uploadToGAS") {
    try {
      fetchWithTimeout(request.gasUrl, {
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
          return { status: "error", message: "服务端返回了无效的数据格式" };
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
      fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + groqKey
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: [
            {
              role: "system",
              content: "你是专业翻译。将用户发送的文字**整体**翻译为中文，理解完整语义后再输出，不要逐行翻译，保持自然流畅。只返回翻译结果，不要任何解释、前缀或额外内容。"
            },
            { role: "user", content: text }
          ],
          temperature: 0.2,
          max_completion_tokens: 2048,
          reasoning_effort: "low",
          include_reasoning: false
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
      return fetchWithTimeout("https://api.ocr.space/parse/image", {
        method: "POST",
        headers: { "apikey": key },
        body: fd
      }).then(r => r.json());
    }

    // 优先 Engine 选择：helloworld → 直接用 1；有注册 Key → 先试 2，失败降级到 1
    const preferred = (key === "helloworld") ? 1 : 2;

    doOCR(preferred)
      .then(data => {

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
        sendResponse({ success: false, error: "网络错误：" + err.toString() });
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

      fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
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
          sendResponse({ success: false, error: "Whisper 识别失败，请检查额度与音频格式" });
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

}

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
    fetchWithTimeout(url)
      .then(r => r.json())
      .then(data => {
        const part = data[0].map(item => item[0] || "").join("");
        nextChunk(idx + 1, acc.concat(part));
      })
      .catch(() => nextChunk(idx + 1, acc.concat(chunks[idx]))); // 失败时保留原文
  })(0, []);
}

