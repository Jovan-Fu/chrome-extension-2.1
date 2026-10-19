document.addEventListener("DOMContentLoaded", () => {
  const gasInput      = document.getElementById("gas-url");
  const sheetInput    = document.getElementById("sheet-id");
  const sheetNameInput= document.getElementById("sheet-name");
  const folderInput   = document.getElementById("folder-id");
  const optDownload   = document.getElementById("opt-download");
  const optFolder     = document.getElementById("opt-folder");
  const optNotes      = document.getElementById("opt-notes");
  const optUrl        = document.getElementById("opt-url");
  const catContainer  = document.getElementById("cat-container");
  const catCsv        = document.getElementById("cat-csv");
  const newCatInput   = document.getElementById("new-cat-input");
  const addCatBtn     = document.getElementById("add-cat-btn");
  const copyCatsBtn   = document.getElementById("copy-cats-btn");
  const exportBtn     = document.getElementById("export-btn");
  const copyConfigBtn = document.getElementById("copy-config-btn");
  const exportArea    = document.getElementById("export-area");
  const importArea    = document.getElementById("import-area");
  const importBtn     = document.getElementById("import-btn");
  const clearImportBtn= document.getElementById("clear-import-btn");
  const statusMsg     = document.getElementById("status-msg");

  const ALL_KEYS = ["gasUrl","sheetId","sheetName","folderId","categories",
                    "layoutMode","optDownload","optFolder","optNotes","optUrl","ocrAutoCheck",
                    "catDateMode","speechDuration"];

  function showStatus(text, color = "green") {
    statusMsg.textContent = text;
    statusMsg.style.color = color;
    setTimeout(() => { if (statusMsg.textContent === text) statusMsg.textContent = ""; }, 2000);
  }

  // Tab 切换
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // 排列方向
  function setLayout(mode, save) {
    document.getElementById("layout-horizontal").classList.toggle("active", mode === "horizontal");
    document.getElementById("layout-vertical").classList.toggle("active", mode === "vertical");
    if (save !== false) {
      chrome.storage.local.set({ layoutMode: mode }, () =>
        showStatus("⚡ 已切换为" + (mode === "horizontal" ? "横排" : "竖排") + "模式"));
    }
  }
  document.querySelectorAll(".layout-btn").forEach(btn => {
    btn.addEventListener("click", () => setLayout(btn.dataset.layout));
  });

  // 初始化
  chrome.storage.local.get(ALL_KEYS, (data) => {
    if (data.gasUrl)    gasInput.value       = data.gasUrl;
    if (data.sheetId)   sheetInput.value     = data.sheetId;
    if (data.sheetName) sheetNameInput.value = data.sheetName;
    if (data.folderId)  folderInput.value    = data.folderId;
    optDownload.checked = data.optDownload !== false;
    optFolder.checked   = data.optFolder   !== false;
    optNotes.checked    = data.optNotes    !== false;
    optUrl.checked      = data.optUrl      !== false;
    document.getElementById("opt-ocr-auto").checked  = data.ocrAutoCheck !== false;
    document.getElementById("opt-cat-date").checked  = data.catDateMode  !== false;
    const durationSelect = document.getElementById("opt-speech-duration");
    if (durationSelect) durationSelect.value = String(data.speechDuration || 60);
    setLayout(data.layoutMode || "horizontal", false);
    renderCategories(data.categories || ["默认","灵感素材","竞品分析","视频剪辑"]);
  });

  // 实时保存
  gasInput.addEventListener("input",       e => chrome.storage.local.set({ gasUrl:    e.target.value.trim() }, () => showStatus("⚡ 已保存")));
  sheetInput.addEventListener("input",     e => chrome.storage.local.set({ sheetId:   e.target.value.trim() }, () => showStatus("⚡ 已保存")));
  sheetNameInput.addEventListener("input", e => chrome.storage.local.set({ sheetName: e.target.value.trim() }, () => showStatus("⚡ 已保存")));
  folderInput.addEventListener("input",    e => chrome.storage.local.set({ folderId:  e.target.value.trim() }, () => showStatus("⚡ 已保存")));
  optDownload.addEventListener("change",   e => chrome.storage.local.set({ optDownload: e.target.checked }, () => showStatus("⚡ 已保存")));
  optFolder.addEventListener("change",     e => chrome.storage.local.set({ optFolder:   e.target.checked }, () => showStatus("⚡ 已保存")));
  optNotes.addEventListener("change",      e => chrome.storage.local.set({ optNotes:    e.target.checked }, () => showStatus("⚡ 已保存")));
  optUrl.addEventListener("change",        e => chrome.storage.local.set({ optUrl:      e.target.checked }, () => showStatus("⚡ 已保存")));
  document.getElementById("opt-ocr-auto").addEventListener("change", e => chrome.storage.local.set({ ocrAutoCheck: e.target.checked }, () => showStatus("⚡ 已保存")));
  document.getElementById("opt-cat-date").addEventListener("change", e => chrome.storage.local.set({ catDateMode: e.target.checked }, () => showStatus("⚡ 已保存")));
  const durationSelectEl = document.getElementById("opt-speech-duration");
  if (durationSelectEl) {
    durationSelectEl.addEventListener("change", e => chrome.storage.local.set({ speechDuration: parseInt(e.target.value) || 60 }, () => showStatus("⚡ 时长已保存")));
  }

  // 分类管理
  function renderCategories(list) {
    catContainer.innerHTML = "";
    list.forEach((cat, i) => {
      const tag = document.createElement("div");
      tag.className = "cat-tag";
      tag.textContent = cat;
      const del = document.createElement("span");
      del.className = "cat-del";
      del.innerHTML = "&times;";
      del.addEventListener("click", () => removeCategory(i));
      tag.appendChild(del);
      catContainer.appendChild(tag);
    });
    catCsv.value = list.join(", ");
  }

  copyCatsBtn.addEventListener("click", () => {
    catCsv.select();
    document.execCommand("copy");
    showStatus("✅ 分类列表已复制");
    copyCatsBtn.textContent = "✓ 已复制";
    setTimeout(() => { copyCatsBtn.textContent = "复制"; }, 1500);
  });

  addCatBtn.addEventListener("click", addCategory);
  newCatInput.addEventListener("keydown", e => { if (e.key === "Enter") addCategory(); });

  function addCategory() {
    const val = newCatInput.value.trim();
    if (!val) return;
    if (val.length > 200 || /[|\r\n]/.test(val)) { showStatus("分类最长 200 字，不能包含换行或竖线", "#d93025"); return; }
    chrome.storage.local.get(["categories"], (data) => {
      let list = data.categories || ["默认","灵感素材","竞品分析","视频剪辑"];
      if (!list.includes(val)) {
        list.push(val);
        chrome.storage.local.set({ categories: list }, () => {
          renderCategories(list);
          newCatInput.value = "";
          showStatus("✅ 已添加：" + val);
        });
      } else {
        showStatus("⚠️ 该分类已存在", "#d93025");
      }
    });
  }

  function removeCategory(index) {
    chrome.storage.local.get(["categories"], (data) => {
      let list = data.categories || [];
      list.splice(index, 1);
      chrome.storage.local.set({ categories: list }, () => {
        renderCategories(list);
        showStatus("🗑️ 已删除", "#d93025");
      });
    });
  }

  // 导出配置
  exportBtn.addEventListener("click", () => {
    chrome.storage.local.get(ALL_KEYS, (data) => {
      const config = {
        _note:       "智能截图助手 Pro v2.1 配置 — " + new Date().toLocaleString("zh-CN"),
        gasUrl:      data.gasUrl      || "",
        sheetId:     data.sheetId     || "",
        sheetName:   data.sheetName   || "",
        folderId:    data.folderId    || "",
        categories:  data.categories  || ["默认","灵感素材","竞品分析","视频剪辑"],
        layoutMode:  data.layoutMode  || "horizontal",
        optDownload: data.optDownload !== false,
        optFolder:   data.optFolder   !== false,
        optNotes:    data.optNotes    !== false,
        optUrl:      data.optUrl      !== false
      };
      exportArea.value = JSON.stringify(config, null, 2);
      showStatus("✅ 配置已生成，点「复制配置」发给好友");
    });
  });

  copyConfigBtn.addEventListener("click", () => {
    if (!exportArea.value) { exportBtn.click(); setTimeout(doCopy, 300); }
    else doCopy();
    function doCopy() {
      exportArea.select();
      document.execCommand("copy");
      showStatus("✅ 已复制到剪贴板！");
      copyConfigBtn.textContent = "✓ 已复制";
      setTimeout(() => { copyConfigBtn.textContent = "⚡ 复制配置"; }, 1500);
    }
  });

  // 导入配置
  clearImportBtn.addEventListener("click", () => { importArea.value = ""; });

  importBtn.addEventListener("click", () => {
    const raw = importArea.value.trim();
    if (!raw) { showStatus("⚠️ 请先粘贴配置 JSON", "#d93025"); return; }
    let config;
    try { config = JSON.parse(raw); }
    catch(e) { showStatus("❌ JSON 格式错误，请检查", "#d93025"); return; }

    let toSave;
    try { toSave = validateImportedConfig(config); }
    catch (error) { showStatus("❌ " + error.message, "#d93025"); return; }

    chrome.storage.local.set(toSave, () => {
      if (toSave.gasUrl)    gasInput.value       = toSave.gasUrl;
      if (toSave.sheetId)   sheetInput.value     = toSave.sheetId;
      if (toSave.sheetName !== undefined) sheetNameInput.value = toSave.sheetName;
      if (toSave.folderId)  folderInput.value    = toSave.folderId;
      if (toSave.categories) renderCategories(toSave.categories);
      if (toSave.layoutMode) setLayout(toSave.layoutMode, false);
      if (typeof toSave.optDownload === "boolean") optDownload.checked = toSave.optDownload;
      if (typeof toSave.optFolder   === "boolean") optFolder.checked   = toSave.optFolder;
      if (typeof toSave.optNotes    === "boolean") optNotes.checked    = toSave.optNotes;
      if (typeof toSave.optUrl      === "boolean") optUrl.checked      = toSave.optUrl;
      importArea.value = "";
      showStatus("✅ 配置导入成功！请刷新目标网页生效");
    });
  });
});

// ── OCR 配置与额度 ────────────────────────────────────────────
(function initOCR() {
  const visionKeyInput = document.getElementById("vision-key");
  const eyeBtn         = document.getElementById("eye-btn");
  const groqKeyInput   = document.getElementById("groq-key");
  const groqEyeBtn     = document.getElementById("groq-eye-btn");
  const ocrLimitInput  = document.getElementById("ocr-limit");
  const ocrBar         = document.getElementById("ocr-bar");
  const ocrUsedText    = document.getElementById("ocr-used-text");
  const ocrRemainText  = document.getElementById("ocr-remain-text");
  const ocrMonthText   = document.getElementById("ocr-month-text");
  const ocrResetBtn    = document.getElementById("ocr-reset-btn");
  const statusMsg      = document.getElementById("status-msg");

  function showStatus(text, color = "green") {
    statusMsg.textContent = text;
    statusMsg.style.color = color;
    setTimeout(() => { if (statusMsg.textContent === text) statusMsg.textContent = ""; }, 2000);
  }

  // 更新额度显示
  function renderOcrStats(used, limit, monthKey) {
    const pct     = Math.min((used / limit) * 100, 100);
    const remain  = Math.max(limit - used, 0);
    ocrBar.style.width = pct + "%";
    ocrBar.className   = "ocr-bar-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    ocrUsedText.textContent   = "已用 " + used + " 次";
    ocrRemainText.textContent = "剩余 " + remain + " 次";
    ocrMonthText.textContent  = "统计周期：" + monthKey + "（每月自动重置）";
  }

  // 获取当前月份 key，格式 "2025-06"
  function currentMonthKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  // 加载 OCR 数据
  function loadOcrData() {
    chrome.storage.local.get(["visionKey", "groqKey", "ocrLimit", "ocrUsed", "ocrMonth"], (data) => {
      if (data.visionKey) visionKeyInput.value = data.visionKey;
      if (data.groqKey)   groqKeyInput.value   = data.groqKey;
      ocrLimitInput.value = data.ocrLimit || 25000;

      const monthKey = currentMonthKey();
      let used = data.ocrUsed || 0;

      // 新的一个月自动重置
      if (data.ocrMonth && data.ocrMonth !== monthKey) {
        used = 0;
        chrome.storage.local.set({ ocrUsed: 0, ocrMonth: monthKey });
      } else if (!data.ocrMonth) {
        chrome.storage.local.set({ ocrMonth: monthKey });
      }

      renderOcrStats(used, data.ocrLimit || 25000, monthKey);
    });
  }

  loadOcrData();

  // 显示/隐藏 Vision Key
  eyeBtn.addEventListener("click", () => {
    const isHidden = visionKeyInput.type === "password";
    visionKeyInput.type = isHidden ? "text" : "password";
    eyeBtn.textContent  = isHidden ? "🙈" : "👁️";
  });

  // 显示/隐藏 Groq Key
  groqEyeBtn.addEventListener("click", () => {
    const isHidden = groqKeyInput.type === "password";
    groqKeyInput.type = isHidden ? "text" : "password";
    groqEyeBtn.textContent = isHidden ? "🙈" : "👁️";
  });

  // 保存 Vision Key
  visionKeyInput.addEventListener("input", (e) => {
    chrome.storage.local.set({ visionKey: e.target.value.trim() }, () => showStatus("⚡ Key 已保存"));
  });

  // 保存 Groq Key
  groqKeyInput.addEventListener("input", (e) => {
    chrome.storage.local.set({ groqKey: e.target.value.trim() }, () => showStatus("⚡ Groq Key 已保存"));
  });

  // 保存额度上限
  ocrLimitInput.addEventListener("input", (e) => {
    const val = parseInt(e.target.value) || 25000;
    chrome.storage.local.set({ ocrLimit: val }, () => {
      chrome.storage.local.get(["ocrUsed"], (d) => {
        renderOcrStats(d.ocrUsed || 0, val, currentMonthKey());
      });
    });
  });

  // 手动重置计数
  ocrResetBtn.addEventListener("click", () => {
    if (!confirm("确认重置本月使用计数为 0？")) return;
    const monthKey = currentMonthKey();
    chrome.storage.local.set({ ocrUsed: 0, ocrMonth: monthKey }, () => {
      renderOcrStats(0, parseInt(ocrLimitInput.value) || 25000, monthKey);
      showStatus("✅ 计数已重置");
    });
  });
})();


// 导入只接受已知字段及其预期类型，防止损坏配置与后台请求目标污染。
function validateImportedConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须为 JSON 对象");
  const saved = {};
  const limits = { gasUrl: 2048, sheetId: 2048, sheetName: 100, folderId: 2048 };
  for (const [name, max] of Object.entries(limits)) {
    if (Object.hasOwn(config, name)) {
      if (typeof config[name] !== "string" || config[name].length > max) throw new Error("字段格式无效：" + name);
      saved[name] = config[name].trim();
    }
  }
  if (saved.gasUrl) {
    let url;
    try { url = new URL(saved.gasUrl); } catch { throw new Error("GAS 地址格式无效"); }
    if (url.origin !== "https://script.google.com" || url.username || url.password || url.search || url.hash ||
        !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw new Error("仅允许正式的 HTTPS GAS 部署地址");
  }
  if (Object.hasOwn(config, "categories")) {
    if (!Array.isArray(config.categories) || config.categories.length > 500 ||
        config.categories.some(c => typeof c !== "string" || !c.trim() || c.length > 200 || /[|\r\n]/.test(c))) {
      throw new Error("分类必须为最多 500 项的文本数组，不能包含换行或竖线");
    }
    saved.categories = [...new Set(config.categories.map(c => c.trim()))];
  }
  if (Object.hasOwn(config, "layoutMode")) {
    if (!["horizontal", "vertical"].includes(config.layoutMode)) throw new Error("排列方式无效");
    saved.layoutMode = config.layoutMode;
  }
  for (const name of ["optDownload", "optFolder", "optNotes", "optUrl"]) {
    if (Object.hasOwn(config, name)) {
      if (typeof config[name] !== "boolean") throw new Error("选项必须为布尔值：" + name);
      saved[name] = config[name];
    }
  }
  return saved;
}
