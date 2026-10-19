if (!window.fbsHasRun) {
  window.fbsHasRun = true;
  initScreenshotTool();
}

function initScreenshotTool() {
  createFloatingBar();
}

// ── 平台检测 ──────────────────────────────────────────────────
function detectPlatform() {
  const h = location.hostname;
  if (h.includes("facebook.com"))  return { name: "Facebook",  icon: "📘" };
  if (h.includes("youtube.com"))   return { name: "YouTube",   icon: "▶️"  };
  if (h.includes("instagram.com")) return { name: "Instagram", icon: "📷" };
  if (h.includes("tiktok.com"))    return { name: "TikTok",    icon: "🎵" };
  if (h.includes("pinterest.com")) return { name: "Pinterest", icon: "📌" };
  if (h.includes("behance.net"))   return { name: "Behance",   icon: "🎨" };
  if (h.includes("dribbble.com"))  return { name: "Dribbble",  icon: "🏀" };
  if (h.includes("flickr.com"))    return { name: "Flickr",    icon: "🌄" };
  return { name: "Web", icon: "🌐" };
}

// ── 悬浮工具栏 ────────────────────────────────────────────────
function createFloatingBar() {
  if (document.getElementById("fbs-float-bar")) return;
  const platform = detectPlatform();

  const bar = document.createElement("div");
  bar.id = "fbs-float-bar";

  const badge = document.createElement("div");
  badge.textContent = platform.icon;
  badge.style.cssText = "font-size:14px;text-align:center;padding:2px 0 4px 0;cursor:default;";
  bar.appendChild(badge);

  const handle = document.createElement("div");
  handle.id = "fbs-drag-handle";
  [1,2].forEach(() => { const l = document.createElement("div"); l.className = "fbs-drag-line"; handle.appendChild(l); });
  bar.appendChild(handle);

  const btnVideo  = createBarBtn("🎥", "截取当前视频", handleVideoCapture);
  const btnArea   = createBarBtn("✂️", "自由框选截图", handleAreaCapture);
  const btnSpeech = createBarBtn("🎙️", "提取视频台词 (语音转文字)", handleSpeechRecognition);
  bar.appendChild(btnVideo);
  bar.appendChild(btnArea);
  bar.appendChild(btnSpeech);

  document.body.appendChild(bar);
  makeElementDraggable(bar, handle);
}

function createBarBtn(icon, tip, handler) {
  const btn = document.createElement("button");
  btn.className = "fbs-float-btn";
  btn.textContent = icon;
  const tooltip = document.createElement("span");
  tooltip.className = "fbs-tooltip";
  tooltip.textContent = tip;
  btn.appendChild(tooltip);
  btn.addEventListener("click", event => { if (event.isTrusted) handler(); });
  return btn;
}

// ── 拖拽 ──────────────────────────────────────────────────────
function makeElementDraggable(elm, handle) {
  let pos2 = 0, pos4 = 0;
  handle.onmousedown = function(e) {
    e.preventDefault();
    pos4 = e.clientY;
    document.onmouseup   = () => { document.onmouseup = null; document.onmousemove = null; };
    document.onmousemove = function(e) {
      e.preventDefault();
      pos2 = pos4 - e.clientY; pos4 = e.clientY;
      let t = Math.max(10, Math.min(elm.offsetTop - pos2, window.innerHeight - 150));
      elm.style.top = t + "px";
    };
  };
}

// ── 视频查找 ──────────────────────────────────────────────────
function findActiveVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (!videos.length) return null;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
    if (inView && !v.paused) return v;
  }
  for (const v of videos) { if (!v.paused) return v; }
  return videos.reduce((best, v) => {
    const r = v.getBoundingClientRect();
    const a = r.width * r.height;
    return a > (best ? best.getBoundingClientRect().width * best.getBoundingClientRect().height : 0) ? v : best;
  }, null);
}

// ── 页面标题 ──────────────────────────────────────────────────
function getPageTitle() {
  const sel = [
    "h1.ytd-video-primary-info-renderer",
    "yt-formatted-string.ytd-video-primary-info-renderer",
    "[data-e2e='browse-video-desc']",
    ".video-meta-title"
  ];
  for (const s of sel) {
    const el = document.querySelector(s);
    if (el) return el.textContent.trim();
  }
  return document.title || "截图";
}

// ── 视频语音识别与台词提取（带本地链接缓存）──────────────────────
function getVideoSpeechKey() {
  const url = window.location.href;
  const patterns = [/reels\/(\d+)/, /[?&]v=([\w-]+)/, /\/video\/(\d+)/,
                    /\/reel\/([\w-]+)/, /\/p\/([\w-]+)/, /\/pin\/(\d+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return "stt_v2_" + encodeURIComponent(location.origin) + "_" + m[1];
  }
  const clean = url.split("?")[0].split("#")[0].replace(/\/$/, "");
  return "stt_v2_" + encodeURIComponent(clean);
}

// 统一获取或提取视频台词（优先直接调用缓存）
function getOrExtractSpeech(callback, forceRefresh) {
  const cacheKey = getVideoSpeechKey();
  chrome.storage.local.get([cacheKey, "speechDuration"], async (d) => {
    // 1. 如果已有台词缓存且不强制刷新，直接调用！不发起二次提取
    if (!forceRefresh && d[cacheKey] && d[cacheKey].text) {
      callback(d[cacheKey], true);
      return;
    }

    // 2. 无缓存时开始提取
    const aiConfig = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: "getAIConfig" }, resolve));
    if (!aiConfig?.hasGroqKey) {
      showToast("⚠️ 请先在插件「🔍 OCR/AI」标签页填写 Groq Key", "#d93025");
      callback(null, false);
      return;
    }

    const video = findActiveVideo();
    if (!video) {
      showToast("⚠️ 未找到正在播放的视频，请先播放视频后重试", "#d93025");
      callback(null, false);
      return;
    }

    const maxSeconds = [15, 30, 60, 120, 300].includes(d.speechDuration) ? d.speechDuration : 60;

    // 录音悬浮控制条
    let recordBar = document.getElementById("fbs-record-bar");
    if (!recordBar) {
      recordBar = document.createElement("div");
      recordBar.id = "fbs-record-bar";
      document.body.appendChild(recordBar);
    }

    recordBar.innerHTML = `
      <div class="fbs-record-dot"></div>
      <span id="fbs-record-text">🎙️ 正在提取视频语音 (0s/${maxSeconds}s)...</span>
      <button class="fbs-record-btn-stop" id="fbs-record-stop">⏹️ 立即识别</button>
      <button class="fbs-record-btn-restart" id="fbs-record-restart">⏮️ 从头识别</button>
      <button class="fbs-record-btn-cancel" id="fbs-record-cancel">✖️ 取消</button>
    `;

    let isCancelled = false;
    let stopFn = null;

    document.getElementById("fbs-record-cancel").onclick = () => {
      isCancelled = true;
      if (stopFn) stopFn();
      recordBar.remove();
      callback(null, false);
    };

    document.getElementById("fbs-record-stop").onclick = () => {
      if (stopFn) stopFn();
    };

    // 从头识别：重置到视频开头再录
    document.getElementById("fbs-record-restart").onclick = () => {
      video.currentTime = 0;
      video.play().catch(() => {});
      showToast("⏮️ 已从头开始，继续识别中...", "#1877f2");
    };

    try {
      const audioBlob = await recordVideoAudio(video, maxSeconds, (sec, total) => {
        const txt = document.getElementById("fbs-record-text");
        if (txt) txt.textContent = `🎙️ 正在提取视频语音 (${sec}s / 最多 ${total}s)...`;
      }, (fn) => { stopFn = fn; });

      if (isCancelled) return;

      const txt = document.getElementById("fbs-record-text");
      if (txt) txt.textContent = "🔄 正在使用 Groq Whisper 极速转换中...";
      const stopBtn = document.getElementById("fbs-record-stop");
      if (stopBtn) stopBtn.style.display = "none";

      const reader = new FileReader();
      reader.onloadend = function() {
        const audioBase64 = reader.result;
        chrome.runtime.sendMessage({
          action: "transcribeAudio",
          audioBase64,
          mimeType: audioBlob.type || "audio/webm"
        }, (sttRes) => {
          if (!sttRes || !sttRes.success || !sttRes.text) {
            recordBar.remove();
            showToast("❌ " + (sttRes?.error || "语音识别失败"), "#d93025");
            callback(null, false);
            return;
          }

          if (txt) txt.textContent = "🔄 正在翻译为中文...";
          chrome.runtime.sendMessage({
            action: "translateText",
            text: sttRes.text
          }, (trRes) => {
            recordBar.remove();
            const zh = (trRes && trRes.success && trRes.zh) ? trRes.zh : "";
            const resultData = {
              text: sttRes.text,
              zh: zh,
              language: sttRes.language || "",
              url: window.location.href,
              time: Date.now()
            };

            // 缓存保存：同一链接后续直接读取，无需重复提取
            chrome.storage.local.set({ [cacheKey]: resultData });
            callback(resultData, false);
          });
        });
      };
      reader.readAsDataURL(audioBlob);

    } catch (err) {
      recordBar.remove();
      showToast("❌ 提取音频失败：" + err.message, "#d93025");
      callback(null, false);
    }
  });
}


// 录制视频声音（静音加速模式：设 2x 倍速，缩短等待时间同时保持语音识别精度）
async function recordVideoAudio(video, maxSeconds, onProgress, registerStop) {
  // ── 保存原始视频状态 ──
  const origMuted       = video.muted;
  const origPlaybackRate = video.playbackRate;
  const origVolume      = video.volume;

  // 2x 倍速：音频仍可被 Whisper 准确识别，等待时间减半
  // 注意：超过 4x 时音频严重变形，Whisper 精度会急剧下降
  const SPEED = 2;

  let stream = null;
  try {
    if (video.captureStream) {
      stream = video.captureStream();
    } else if (video.mozCaptureStream) {
      stream = video.mozCaptureStream();
    }
  } catch(e) {}

  let audioStream = null;
  let playbackContext = null;
  if (stream && stream.getAudioTracks().length > 0) {
    audioStream = new MediaStream(stream.getAudioTracks());
  }

  // 跨域受限视频使用 tabCapture 兜底（tabCapture 不支持加速，仍实时）
  let isTabCapture = false;
  if (!audioStream) {
    try {
      const resp = await new Promise(r => chrome.runtime.sendMessage({ action: "getTabStreamId" }, r));
      if (resp && resp.success && resp.streamId) {
        const tabStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: resp.streamId
            }
          },
          video: false
        });
        if (tabStream && tabStream.getAudioTracks().length > 0) {
          audioStream = tabStream;
          isTabCapture = true;
          try {
            playbackContext = new AudioContext();
            const src = playbackContext.createMediaStreamSource(tabStream);
            src.connect(playbackContext.destination);
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  if (!audioStream) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    throw new Error("未能捕获到视频音轨，请确保视频正在播放并有声音");
  }

  const releaseCapture = () => {
    new Set([...(stream ? stream.getTracks() : []), ...audioStream.getTracks()])
      .forEach(track => track.stop());
    if (playbackContext) playbackContext.close().catch(() => {});
  };

  // 对 captureStream 音轨启用加速（tabCapture 无法加速，保持原速）
  if (!isTabCapture) {
    video.muted = true;        // 静音：播放时不发出声音
    video.volume = 0;
    video.playbackRate = SPEED; // 加速：16x
  }

  const restoreVideo = () => {
    try {
      video.muted        = origMuted;
      video.playbackRate = origPlaybackRate;
      video.volume       = origVolume;
    } catch(e) {}
  };

  return new Promise((resolve, reject) => {
    let recorder;
    try {
      recorder = new MediaRecorder(audioStream, { mimeType: "audio/webm" });
    } catch(e) {
      try {
        recorder = new MediaRecorder(audioStream);
      } catch(err2) {
        releaseCapture();
        restoreVideo();
        return reject(new Error("浏览器不支持当前音频格式录制"));
      }
    }

    const chunks = [];
    recorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    let timer = null;
    let elapsed = 0;   // 实际经过秒数（wall clock）
    let stopped = false;

    const onVideoEnded = () => {
      console.log("[STT] 视频播放结束，自动完成录音");
      stop();
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      video.removeEventListener("ended", onVideoEnded);
      if (timer) clearInterval(timer);
      restoreVideo();
      if (recorder.state === "recording") recorder.stop();
    };

    if (registerStop) registerStop(stop);

    recorder.onstop = () => {
      releaseCapture();
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      resolve(blob);
    };

    recorder.onerror = err => {
      video.removeEventListener("ended", onVideoEnded);
      if (timer) clearInterval(timer);
      releaseCapture();
      restoreVideo();
      reject(err);
    };

    // 监听视频结束事件：若视频在中途播完，直接结束录音无需傻等
    video.addEventListener("ended", onVideoEnded);

    try {
      recorder.start(500);
    } catch (error) {
      video.removeEventListener("ended", onVideoEnded);
      releaseCapture();
      restoreVideo();
      reject(error);
      return;
    }
    if (video.paused) video.play().catch(() => {});

    // 计时器以实际 wall-clock 秒为准；加速下内容时长 = elapsed * SPEED
    timer = setInterval(() => {
      elapsed++;
      // 向上层报告「已覆盖音频时长」而非 wall-clock 秒
      const coveredSec = isTabCapture ? elapsed : Math.min(elapsed * SPEED, maxSeconds);
      if (onProgress) onProgress(coveredSec, maxSeconds);
      // wall-clock 触发时间 = maxSeconds / SPEED（加速模式下更快结束）
      const wallLimit = isTabCapture ? maxSeconds : Math.ceil(maxSeconds / SPEED);
      if (elapsed >= wallLimit) stop();
    }, 1000);
  });
}

// 悬浮工具栏点击处理
function handleSpeechRecognition() {
  getOrExtractSpeech((result, fromCache) => {
    if (!result) return;
    showSpeechModal(result, fromCache);
  });
}

// 展示语音台词卡片
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function showSpeechModal(data, fromCache) {
  const existing = document.getElementById("fbs-speech-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "fbs-speech-modal";

  // 语言名称 → 中文名称 + 国旗（verbose_json 返回英文全名，如 "english"、"portuguese"）
  const LANG_MAP = {
    english: "🇺🇸 英语", spanish: "🇪🇸 西班牙语", french: "🇫🇷 法语", german: "🇩🇪 德语",
    italian: "🇮🇹 意大利语", portuguese: "🇧🇷 葡萄牙语", russian: "🇷🇺 俄语",
    japanese: "🇯🇵 日语", korean: "🇰🇷 韩语", chinese: "🇨🇳 中文",
    arabic: "🇸🇦 阿拉伯语", hindi: "🇮🇳 印地语", dutch: "🇳🇱 荷兰语",
    polish: "🇵🇱 波兰语", turkish: "🇹🇷 土耳其语", vietnamese: "🇻🇳 越南语",
    thai: "🇹🇭 泰语", indonesian: "🇮🇩 印度尼西亚语", malay: "🇲🇾 马来语",
    ukrainian: "🇺🇦 乌克兰语", swedish: "🇸🇪 瑞典语", danish: "🇩🇰 丹麦语",
    finnish: "🇫🇮 芬兰语", norwegian: "🇳🇴 挪威语", czech: "🇨🇿 捷克语",
    slovak: "🇸🇰 斯洛伐克语", romanian: "🇷🇴 罗马尼亚语", hungarian: "🇭🇺 匈牙利语",
    greek: "🇬🇷 希腊语", hebrew: "🇮🇱 希伯来语", persian: "🇮🇷 波斯语",
    urdu: "🇵🇰 乌尔都语", bengali: "🇧🇩 孟加拉语", tamil: "🇮🇳 泰米尔语",
    swahili: "🌍 斯瓦希里语", tagalog: "🇵🇭 菲律宾语", catalan: "🇪🇸 加泰罗尼亚语",
    croatian: "🇭🇷 克罗地亚语", serbian: "🇷🇸 塞尔维亚语", bulgarian: "🇧🇬 保加利亚语",
    lithuanian: "🇱🇹 立陶宛语", latvian: "🇱🇻 拉脱维亚语", estonian: "🇪🇪 爱沙尼亚语",
    slovenian: "🇸🇮 斯洛文尼亚语", afrikaans: "🇿🇦 南非荷兰语",
  };
  const langCode = (data.language || "").toLowerCase().trim();
  const langLabel = Object.hasOwn(LANG_MAP, langCode) ? LANG_MAP[langCode] : (langCode ? `🌐 ${langCode}` : "");

  const fullText = (data.zh ? data.zh + "\n----------\n" : "") + data.text;

  modal.innerHTML = `
    <div class="fbs-speech-header">
      <span>🎙️ 视频台词内容</span>
      <span style="font-size:18px;cursor:pointer;color:#8a8d91;" id="fbs-speech-close">✕</span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:11px;color:${fromCache ? "#24b263" : "#1877f2"};font-weight:600;">
        ${fromCache ? "⚡ 已直接读取本地台词缓存（无需重复提取）" : "✅ 语音提取与翻译完成"}
      </div>
      ${langLabel ? `<div style="font-size:12px;background:#f0f2f5;border-radius:10px;padding:2px 10px;color:#1c1e21;font-weight:600;">${escapeHTML(langLabel)}</div>` : ""}
    </div>
    <div class="fbs-speech-content" id="fbs-speech-text-box"></div>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="fbs-btn fbs-btn-sec" style="flex:1;" id="fbs-speech-copy">📋 复制全部</button>
      <button class="fbs-btn fbs-btn-sec" style="flex:1;" id="fbs-speech-reextract">🔄 重新提取</button>
      <button class="fbs-btn" style="flex:1;" id="fbs-speech-done">完成</button>
    </div>
  `;

  modal.querySelector("#fbs-speech-text-box").textContent =
    (data.zh ? "🇨🇳 中文翻译：\n" + data.zh + "\n\n" : "") + "🔤 原文台词：\n" + data.text;
  document.body.appendChild(modal);

  document.getElementById("fbs-speech-close").onclick = () => modal.remove();
  document.getElementById("fbs-speech-done").onclick = () => modal.remove();
  document.getElementById("fbs-speech-copy").onclick = () => {
    navigator.clipboard.writeText(fullText).then(() => {
      showToast("📋 台词与翻译已复制到剪贴板");
    });
  };
  // 重新提取：清除缓存并强制重新提取
  document.getElementById("fbs-speech-reextract").onclick = event => {
    if (!event.isTrusted) return;
    const cacheKey = getVideoSpeechKey();
    chrome.storage.local.remove(cacheKey, () => {
      modal.remove();
      getOrExtractSpeech((result, fc) => {
        if (!result) return;
        showSpeechModal(result, fc);
      }, true);
    });
  };
}



// ── 视频截图 ──────────────────────────────────────────────────
function handleVideoCapture() {
  const video = findActiveVideo();
  if (!video) { alert("❌ 未检测到视频，切换为框选截图"); handleAreaCapture(); return; }
  const rect = video.getBoundingClientRect();
  captureAndShow({ title: getPageTitle(), url: location.href, platform: detectPlatform().name,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    vw: window.innerWidth, vh: window.innerHeight }, handleVideoCapture);
}

// ── 框选截图 ──────────────────────────────────────────────────
function handleAreaCapture() {
  const overlay = document.createElement("div");
  overlay.id = "fbs-select-overlay";
  const box = document.createElement("div");
  box.id = "fbs-select-box";
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let sx = 0, sy = 0, drawing = false;
  overlay.addEventListener("mousedown", e => {
    if (!e.isTrusted) return;
    drawing = true; sx = e.clientX; sy = e.clientY;
    box.style.cssText = "display:block;left:"+sx+"px;top:"+sy+"px;width:0;height:0;";
  });
  overlay.addEventListener("mousemove", e => {
    if (!e.isTrusted) return;
    if (!drawing) return;
    box.style.width  = Math.abs(e.clientX - sx) + "px";
    box.style.height = Math.abs(e.clientY - sy) + "px";
    box.style.left   = Math.min(e.clientX, sx) + "px";
    box.style.top    = Math.min(e.clientY, sy) + "px";
  });
  overlay.addEventListener("mouseup", e => {
    if (!e.isTrusted) return;
    if (!drawing) return; drawing = false;
    const rect = { x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY),
                   width: Math.abs(sx - e.clientX), height: Math.abs(sy - e.clientY) };
    overlay.remove();
    if (rect.width > 10 && rect.height > 10) {
      captureAndShow({ title: getPageTitle(), url: location.href,
        platform: detectPlatform().name, rect, vw: window.innerWidth, vh: window.innerHeight },
        handleAreaCapture);
    }
  });
}

// ── 截图裁剪 ──────────────────────────────────────────────────
function captureAndShow(info, captureAgain) {
  // 延迟 200ms 再截图：避免视频暂停/弹窗弹出时截到黑帧
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: "captureTab" }, (res) => {
      if (!res || !res.success) { alert("❌ 截图失败，请刷新页面重试"); return; }
      const img = new Image();
      img.src = res.dataUrl;
      img.onload = function() {
        const canvas = document.createElement("canvas");
        canvas.width = info.rect.width; canvas.height = info.rect.height;
        const ctx = canvas.getContext("2d");
        const sx = img.width  / info.vw;
        const sy = img.height / info.vh;
        ctx.drawImage(img, info.rect.x * sx, info.rect.y * sy,
          info.rect.width * sx, info.rect.height * sy, 0, 0, info.rect.width, info.rect.height);
        showSaveModal(canvas.toDataURL("image/jpeg", 0.9), info, captureAgain);
      };
    });
  }, 200);
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(text, color) {
  let t = document.getElementById("fbs-toast");
  if (!t) { t = document.createElement("div"); t.id = "fbs-toast"; document.body.appendChild(t); }
  t.textContent = text;
  t.className = "fbs-toast-show";
  t.style.backgroundColor = color || "rgba(0,0,0,0.85)";
  if (window._fbsToast) clearTimeout(window._fbsToast);
  window._fbsToast = setTimeout(() => {
    t.className = "fbs-toast-hide";
    setTimeout(() => t.remove(), 400);
  }, 3000);
}

// ── 保存弹窗 ──────────────────────────────────────────────────
function showSaveModal(base64, info, captureAgain) {
  const existing = document.getElementById("fbs-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "fbs-modal";

  // 标题栏
  const titleBar = document.createElement("div");
  titleBar.className = "fbs-modal-title";
  titleBar.textContent = "💡 截图保存 · " + (info.platform || "Web");
  const closeBtn = document.createElement("span");
  closeBtn.className = "fbs-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => modal.remove());
  titleBar.appendChild(closeBtn);
  modal.appendChild(titleBar);

  // 预览图
  const preview = document.createElement("div");
  preview.className = "fbs-preview-container";
  const img = document.createElement("img");
  img.className = "fbs-preview-img";
  img.src = base64;
  preview.appendChild(img);
  modal.appendChild(preview);

  // 分类选择
  const catLabel = document.createElement("div");
  catLabel.className = "fbs-label";
  catLabel.textContent = "选择类别";
  modal.appendChild(catLabel);

  const catRow = document.createElement("div");
  catRow.style.cssText = "display:flex;gap:6px;margin-bottom:10px;";
  const selectCat = document.createElement("select");
  selectCat.className = "fbs-input";
  selectCat.style.cssText = "margin-bottom:0!important;flex:1;";
  const addCatInline = document.createElement("button");
  addCatInline.className = "fbs-btn fbs-btn-sec";
  addCatInline.style.cssText = "padding:0 12px!important;";
  addCatInline.textContent = "+";
  catRow.appendChild(selectCat);
  catRow.appendChild(addCatInline);
  modal.appendChild(catRow);

  // 备注（按开关）
  const notesLabel = document.createElement("div");
  notesLabel.className = "fbs-label";
  notesLabel.textContent = "随手记";
  const notesText = document.createElement("textarea");
  notesText.className = "fbs-input";
  notesText.rows = 3;
  notesText.placeholder = "写点灵感...";

  // 按钮
  const btnRow = document.createElement("div");
  btnRow.className = "fbs-btn-row";
  const cancelBtn   = document.createElement("button");
  cancelBtn.className = "fbs-btn fbs-btn-sec";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => modal.remove());
  const continueBtn = document.createElement("button");
  continueBtn.className = "fbs-btn fbs-btn-green";
  continueBtn.textContent = "💾 保存并继续截图";
  const submitBtn   = document.createElement("button");
  submitBtn.className = "fbs-btn";
  submitBtn.textContent = "上传";
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(continueBtn);
  btnRow.appendChild(submitBtn);

  const stateDiv = document.createElement("div");
  stateDiv.id = "fbs-state";

  // OCR 识别文字开关
  const ocrRow      = document.createElement("div");
  ocrRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
  const ocrCheck    = document.createElement("input");
  ocrCheck.type     = "checkbox";
  ocrCheck.id       = "fbs-ocr-check";
  ocrCheck.style.cssText = "width:14px;height:14px;cursor:pointer;accent-color:#1877f2;flex-shrink:0;";
  const ocrLbl      = document.createElement("label");
  ocrLbl.htmlFor    = "fbs-ocr-check";
  ocrLbl.style.cssText = "font-size:12px;color:#1c1e21;cursor:pointer;flex:1;";
  ocrLbl.textContent = "🔍 识别图片文字（自动填入备注）";
  const ocrSpin     = document.createElement("span");
  ocrSpin.style.cssText = "font-size:11px;color:#1877f2;display:none;";
  ocrSpin.textContent   = "识别中...";
  ocrRow.appendChild(ocrCheck);
  ocrRow.appendChild(ocrLbl);
  ocrRow.appendChild(ocrSpin);

  // 根据 optNotes 开关决定是否显示备注框
  chrome.storage.local.get(["optNotes", "categories", "lastSelectedCategory", "catDateMode",
    "ocrUsed", "ocrLimit", "ocrMonth", "ocrAutoCheck"], (data) => {
    if (data.optNotes !== false) {
      modal.appendChild(notesLabel);

      // 始终显示 OCR 开关（无 Key 时自动使用 helloworld 公共测试 Key）
      const monthKey = new Date().getFullYear() + "-" +
        String(new Date().getMonth() + 1).padStart(2, "0");
      const used  = (data.ocrMonth === monthKey) ? (data.ocrUsed || 0) : 0;
      const limit = data.ocrLimit || 25000;

      if (used < limit) {
        modal.appendChild(ocrRow);
        const runOCR = () => {
          if (!ocrCheck.checked) { ocrLbl.textContent = "🔍 识别图片文字（自动填入备注）"; return; }
          ocrSpin.style.display = "inline";
          ocrCheck.disabled = true;
          // API Key 仅在 background.js 中读取，未配置时使用公开测试 Key
          chrome.runtime.sendMessage({
            action: "recognizeText", imageBase64: base64
          }, (res) => {
            ocrSpin.style.display = "none";
            ocrCheck.disabled = false;
            if (res && res.success) {
              if (res.empty) {
                ocrLbl.textContent = "🔍 未识别到文字";
              } else {
                notesText.value = res.text;
                // 总是尝试翻译：无 Key → Google Translate（免费），有 Key → Groq（AI 翻译）
                ocrLbl.textContent = "🔄 翻译中...";
                chrome.runtime.sendMessage({ action: "translateText", text: res.text }, (tr) => {
                  if (tr && tr.success && tr.zh) {
                    notesText.value = tr.zh + "\n----------\n" + res.text;
                    ocrLbl.textContent = "✅ 识别+翻译完成（本月剩余 " + res.ocrRemain + " 次）";
                  } else {
                    // 翻译失败时只显示原文
                    ocrLbl.textContent = "✅ 识别完成（本月剩余 " + res.ocrRemain + " 次）";
                  }
                });
              }
            } else {
              ocrLbl.textContent = "❌ " + (res?.error || "识别失败");
              ocrCheck.checked   = false;
            }
          });
        };
        ocrCheck.addEventListener("change", event => { if (event.isTrusted) runOCR(); });
        // 默认勾选 OCR 并自动触发识别（可在「选项」中关闭）
        if (data.ocrAutoCheck !== false) {
          ocrCheck.checked = true;
          runOCR();
        }
      } else {
        const tip = document.createElement("div");
        tip.style.cssText = "font-size:11px;color:#d93025;margin-bottom:6px;";
        tip.textContent = "⚠️ 本月 OCR 额度已用完（" + used + "/" + limit + " 次）";
        modal.appendChild(tip);
      }

      // 视频台词快捷填入行（支持直接读取链接已有缓存）
      const speechBar = document.createElement("div");
      speechBar.style.cssText = "display:flex;align-items:center;margin-bottom:6px;";
      const speechBtn = document.createElement("button");
      speechBtn.type = "button";
      speechBtn.style.cssText = "font-size:11px;padding:3px 10px;border-radius:12px;cursor:pointer;background:#f0f2f5;border:1px solid #ccd0d5;color:#1c1e21;display:flex;align-items:center;gap:4px;";
      speechBtn.textContent = "🎙️ 提取视频台词（语音转文字）";

      const currentSpeechKey = getVideoSpeechKey();
      chrome.storage.local.get([currentSpeechKey], (scData) => {
        if (scData && scData[currentSpeechKey]) {
          speechBtn.textContent = "⚡ 填入已缓存台词（免提取）";
          speechBtn.style.background = "#e7f8ee";
          speechBtn.style.borderColor = "#24b263";
          speechBtn.style.color = "#1e9651";
          speechBtn.style.fontWeight = "bold";
        }
      });

      speechBtn.addEventListener("click", event => {
        if (!event.isTrusted) return;
        speechBtn.disabled = true;
        const origText = speechBtn.textContent;
        speechBtn.textContent = "⏳ 正在提取...";
        getOrExtractSpeech((res, fromCache) => {
          speechBtn.disabled = false;
          if (res) {
            speechBtn.textContent = "✅ 已填入台词";
            speechBtn.style.background = "#e7f8ee";
            speechBtn.style.borderColor = "#24b263";
            speechBtn.style.color = "#1e9651";
            const formatted = (res.zh ? res.zh + "\n----------\n" : "") + res.text;
            if (notesText.value.trim()) {
              notesText.value += "\n\n" + formatted;
            } else {
              notesText.value = formatted;
            }
            showToast(fromCache ? "⚡ 已直接调用缓存台词" : "✅ 语音提取并填入完成");
          } else {
            speechBtn.textContent = origText;
          }
        });
      });

      speechBar.appendChild(speechBtn);
      modal.appendChild(speechBar);

      modal.appendChild(notesText);
    }
    modal.appendChild(btnRow);
    modal.appendChild(stateDiv);
    document.body.appendChild(modal);

    // ── 加载分类下拉 ────────────────────────────────────────
    // catDateMode=true(默认): 以今天日期为默认分类
    // catDateMode=false: 以上次选中的分类为默认
    const todayStr = new Date().toISOString().slice(0, 10);
    const useDateMode = data.catDateMode !== false;

    // 构建今天日期选项（如果不是 category 模式，放在第一位）
    const todayOpt = document.createElement("option");
    todayOpt.value = todayStr;
    todayOpt.textContent = "📅 " + todayStr + "（今天）";

    const list = data.categories || ["默认", "灵感素材", "竞品分析", "视频剪辑"];

    if (useDateMode) {
      // 日期模式：今天日期在最前，默认选中
      selectCat.appendChild(todayOpt);
      list.filter(c => c !== todayStr).forEach(c => {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        selectCat.appendChild(opt);
      });
      selectCat.value = todayStr;
    } else {
      // 分类模式：已有分类在前，今天日期在后，默认选上次使用的分类
      list.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c; opt.textContent = c;
        selectCat.appendChild(opt);
      });
      if (!list.includes(todayStr)) {
        selectCat.appendChild(todayOpt); // 今天日期附在末尾备选
      }
      // 恢复上次选择
      if (data.lastSelectedCategory && [...selectCat.options].some(o => o.value === data.lastSelectedCategory)) {
        selectCat.value = data.lastSelectedCategory;
      }
    }

    // 切换时保存 lastSelectedCategory
    selectCat.addEventListener("change", () =>
      chrome.storage.local.set({ lastSelectedCategory: selectCat.value }));

    addCatInline.addEventListener("click", () => {
      const val = prompt("请输入新分类名称：");
      if (!val || !val.trim()) return;
      const trimmed = val.trim();
      if (trimmed.length > 200 || /[|\r\n]/.test(trimmed)) { alert("分类最长 200 字，不能包含换行或竖线"); return; }
      chrome.storage.local.get(["categories"], d => {
        let l = d.categories || [];
        if (!l.includes(trimmed)) l.push(trimmed);
        chrome.storage.local.set({ categories: l, lastSelectedCategory: trimmed }, () => {
          const o = document.createElement("option");
          o.value = trimmed; o.textContent = trimmed;
          selectCat.insertBefore(o, useDateMode ? selectCat.options[1] : selectCat.options[0]);
          selectCat.value = trimmed;
        });
      });
    });
  });

  // ── 构建 payload ─────────────────────────────────────────
  function buildPayload(cb) {
    chrome.storage.local.get(
      ["gasUrl", "sheetId", "folderId", "sheetName", "optDownload", "optFolder",
       "optNotes", "optUrl", "layoutMode"], (cfg) => {
      if (!cfg.gasUrl) {
        cb(null, null, "❌ 请在插件弹窗「配置」标签填写 GAS 部署链接");
        return;
      }
      if (!cfg.sheetId || !cfg.folderId) {
        cb(null, null, "❌ 请在插件弹窗「配置」标签填写表格和网盘 ID");
        return;
      }
      const today = new Date();
      const dateStr = today.getFullYear() + "-" +
        String(today.getMonth() + 1).padStart(2, "0") + "-" +
        String(today.getDate()).padStart(2, "0");

      // 提取视频 ID
      let videoId = "";
      const patterns = [/reels\/(\d+)/, /[?&]v=([\w-]+)/, /\/video\/(\d+)/,
                        /\/reel\/([\w-]+)/, /\/p\/([\w-]+)/, /\/pin\/(\d+)/];
      for (const p of patterns) {
        const m = info.url.match(p);
        if (m) { videoId = m[1]; break; }
      }
      if (!videoId) {
        let hash = 0;
        for (let i = 0; i < info.url.length; i++) { hash = (hash << 5) - hash + info.url.charCodeAt(i); hash |= 0; }
        videoId = "id_" + Math.abs(hash);
      }

      const cleanTitle = (info.title || "截图").replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s_-]/g, "").substring(0, 30).trim();
      const folderName = "[" + videoId + "] " + cleanTitle;

      cb({
        imgBase64:   base64,
        videoUrl:    info.url,
        videoTitle:  info.title,
        platform:    info.platform || "Web",
        date:        dateStr,
        category:    selectCat.value,
        notes:       (cfg.optNotes !== false) ? notesText.value.trim() : "",
        sheetId:     cfg.sheetId,
        folderId:    cfg.folderId,
        sheetName:   (cfg.sheetName && typeof cfg.sheetName === "string") ? cfg.sheetName.trim() : "",
        folderName,
        optDownload: cfg.optDownload !== false,
        optFolder:   cfg.optFolder   !== false,
        optNotes:    cfg.optNotes    !== false,
        optUrl:      cfg.optUrl      !== false,
        layoutMode:  cfg.layoutMode  || "horizontal"
      }, cfg.gasUrl, null);
    });
  }

  // ── 执行上传 ─────────────────────────────────────────────
  function doUpload(gasUrl, payload, onSuccess, onFail) {
    chrome.runtime.sendMessage({ action: "uploadToGAS", gasUrl, payload }, (res) => {
      if (res && (res.status === "success" || res.success)) onSuccess();
      else onFail(res?.message || res?.error || "上传失败，请检查配置");
    });
  }

  submitBtn.addEventListener("click", event => {
    if (!event.isTrusted) return;
    stateDiv.style.display = "block";
    stateDiv.style.color   = "#1877f2";
    stateDiv.textContent   = "⏳ 正在上传到谷歌网盘...";
    submitBtn.disabled = true; continueBtn.disabled = true;

    buildPayload((payload, gasUrl, err) => {
      if (err) { stateDiv.style.color = "red"; stateDiv.textContent = err; submitBtn.disabled = false; continueBtn.disabled = false; return; }
      doUpload(gasUrl, payload,
        () => { stateDiv.style.color = "green"; stateDiv.textContent = "✅ 上传成功！"; submitBtn.disabled = false; continueBtn.disabled = false; },
        (e)  => { stateDiv.style.color = "red"; stateDiv.textContent = "❌ " + e; submitBtn.disabled = false; continueBtn.disabled = false; }
      );
    });
  });

  continueBtn.addEventListener("click", event => {
    if (!event.isTrusted) return;
    buildPayload((payload, gasUrl, err) => {
      if (err) { alert(err); return; }
      modal.remove();
      showToast("📤 后台上传中...", "#1877f2");
      doUpload(gasUrl, payload,
        () => showToast("✅ 上传成功！", "#24b263"),
        (e)  => showToast("❌ " + e, "#d93025")
      );
      // 自动触发下一次截图（连续截图模式）
      if (captureAgain) captureAgain();
    });
  });
}
