// ============================================================
//  智能截图助手 Pro v2.1 — Google Apps Script
//  部署方式：Extensions → Apps Script → 粘贴代码 → 部署为 Web 应用
//  执行身份：以我自己身份执行
//  访问权限：所有人（含匿名用户）
// ============================================================

function doPost(e) {
  try {
    if (!e || !e.postData || typeof e.postData.contents !== "string" ||
        e.postData.contents.length > 15 * 1024 * 1024) throw new Error("请求无效或过大");
    var data = JSON.parse(e.postData.contents);
    validateUpload(data);

    var sheetId        = extractId(data.sheetId);
    var parentFolderId = extractId(data.folderId);
    if (!parentFolderId) throw new Error("网盘根文件夹 ID 不能为空");
    if (!sheetId)        throw new Error("谷歌表格 ID 不能为空");

    // 图片数据
    var base64Data = data.imgBase64;
    if (base64Data.indexOf("base64,") !== -1) {
      base64Data = base64Data.split("base64,").pop();
    }

    var videoUrl   = data.videoUrl   || "";
    var videoTitle = data.videoTitle || "未命名";
    var platform   = data.platform   || "Web";
    var dateStr    = data.date;
    var category   = data.category   || "默认";
    var notes      = data.notes      || "";
    var folderName = data.folderName || "截图";
    var sheetName  = (data.sheetName != null) ? String(data.sheetName).trim() : "";

    // 字段开关
    var optDownload = (data.optDownload !== false);
    var optFolder   = (data.optFolder   !== false);
    var optNotes    = (data.optNotes    !== false);
    var optUrl      = (data.optUrl      !== false);

    // 排列模式
    var layoutMode  = data.layoutMode || "horizontal";

    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
      hasLock = lock.tryLock(30000); // 并发排队等待最多30秒
    } catch(e) {}

    if (!hasLock) throw new Error("服务繁忙，请稍后重试");

    try {
      // 1. 网盘根文件夹
      var rootFolder;
      try { rootFolder = DriveApp.getFolderById(parentFolderId); }
      catch(err) { throw new Error("无法打开网盘文件夹：" + err.message); }

      // 2. 日期文件夹
      var dateFolders = rootFolder.getFoldersByName(dateStr);
      var dateFolder  = dateFolders.hasNext() ? dateFolders.next() : rootFolder.createFolder(dateStr);

      // 3. 视频专属文件夹
      var videoFolders = dateFolder.getFoldersByName(folderName);
      var videoFolder  = videoFolders.hasNext() ? videoFolders.next() : dateFolder.createFolder(folderName);

      // 4. 上传图片
      var decodedImg = Utilities.base64Decode(base64Data);
      var timestamp  = Utilities.formatDate(new Date(), "GMT+8", "HH-mm-ss");
      var fileName   = platform + "_截图_" + timestamp + ".jpg";
      var file       = videoFolder.createFile(Utilities.newBlob(decodedImg, "image/jpeg", fileName));
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
      catch(e) { console.log("分享权限受限：" + e.message); }

      var fileId           = file.getId();
      var imageUrlForSheet = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w400";
      var downloadUrl      = "https://drive.google.com/uc?export=download&id=" + fileId;
      var folderUrl        = "https://drive.google.com/drive/folders/" + videoFolder.getId();

      // 5. 打开表格，定位 Sheet
      var ss;
      try { ss = SpreadsheetApp.openById(sheetId); }
      catch(err) { throw new Error("无法打开谷歌表格：" + err.message); }

      var sheet = null;
      if (sheetName !== "") {
        sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
          try {
            sheet = ss.insertSheet(sheetName);
          } catch(errCreate) {
            var allNames = ss.getSheets().map(function(s){ return s.getName(); }).join("、");
            throw new Error("找不到且无法自动创建 Sheet「" + sheetName + "」，现有：" + allNames);
          }
        }
      } else {
        sheet = ss.getSheets().shift();
      }

      // 6. 路由写入
      if (layoutMode === "vertical") {
        writeVertical(sheet, category, dateStr, videoUrl, imageUrlForSheet,
                      downloadUrl, folderUrl, notes, optDownload, optFolder, optNotes, optUrl);
      } else {
        writeHorizontal(sheet, category, dateStr, videoUrl, imageUrlForSheet,
                        downloadUrl, folderUrl, notes, optDownload, optFolder, optNotes, optUrl);
      }
    } finally {
      if (hasLock) {
        try { lock.releaseLock(); } catch(e) {}
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", message: "上传成功" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: "上传失败，请检查配置、输入格式与服务额度" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── 横排写入 ─────────────────────────────────────────────────
function writeHorizontal(sheet, category, dateStr, videoUrl, imageUrlForSheet,
                         downloadUrl, folderUrl, notes,
                         optDownload, optFolder, optNotes, optUrl) {

  var TRACK_ROWS = 2 + (optDownload?1:0) + (optFolder?1:0) + (optNotes?1:0) + (optUrl?1:0);

  // 读取 A1 索引（格式："分类|行号\n分类|行号"）
  var INDEX_CELL = sheet.getRange(1, 1);
  var indexRaw   = INDEX_CELL.getValue().toString();
  var indexMap   = Object.create(null);
  if (indexRaw.trim() !== "") {
    indexRaw.split("\n").forEach(function(line) {
      var parts = line.split("|");
      if (parts.length === 2 && /^[1-9][0-9]*$/.test(parts[1]) && Number(parts[1]) >= 2 && Number(parts[1]) <= sheet.getMaxRows()) {
        indexMap[parts[0].trim()] = parseInt(parts[1].trim());
      }
    });
  }

  var R;

  if (indexMap[category] !== undefined) {
    // ── 已有分类：仅在该分类的行范围内插入一列（不影响其他分类）──
    R = indexMap[category];
    sheet.getRange(R, 4, TRACK_ROWS, 1).insertCells(SpreadsheetApp.Dimension.COLUMNS);

  } else {
    // ── 新分类：插入到最顶部（最新的分类在最上面）──────────────
    var catHeight = TRACK_ROWS + 1; // 内容行 + 1 行分隔符

    if (Object.keys(indexMap).length > 0) {
      // 在第 2 行插入新的分类空间，把所有现有分类往下推
      sheet.insertRows(2, catHeight);
      // 更新已有分类的行号（全部 +catHeight）
      Object.keys(indexMap).forEach(function(cat) {
        indexMap[cat] = indexMap[cat] + catHeight;
      });
      R = 2;
    } else {
      R = 2; // 第一个分类直接从第 2 行开始
    }

    // A 列写分类名
    sheet.getRange(R, 1).setValue(sheetText(category)).setFontWeight("bold");
    // A1 索引字体设白色隐藏
    INDEX_CELL.setFontColor("#ffffff").setFontSize(7);

    // 设置行高
    var rowOffset = 0;
    sheet.setRowHeight(R + rowOffset, 25);  rowOffset++;   // 日期行
    sheet.setRowHeight(R + rowOffset, 160); rowOffset++;   // 图片行
    if (optDownload) { sheet.setRowHeight(R + rowOffset, 25); rowOffset++; }
    if (optFolder)   { sheet.setRowHeight(R + rowOffset, 25); rowOffset++; }
    if (optNotes)    { sheet.setRowHeight(R + rowOffset, 40); rowOffset++; }
    if (optUrl)      { sheet.setRowHeight(R + rowOffset, 25); rowOffset++; }
    sheet.setRowHeight(R + rowOffset, 16); // 分隔行

    // 更新 A1 索引
    indexMap[category] = R;
    saveIndex(INDEX_CELL, indexMap);
  }

  // 写入卡片到 D 列（列 4）
  writeCard(sheet, R, 4, dateStr, videoUrl, imageUrlForSheet,
            downloadUrl, folderUrl, notes, optDownload, optFolder, optNotes, optUrl);
}

// ── 竖排写入 ─────────────────────────────────────────────────
function writeVertical(sheet, category, dateStr, videoUrl, imageUrlForSheet,
                       downloadUrl, folderUrl, notes,
                       optDownload, optFolder, optNotes, optUrl) {

  var TRACK_COLS = 2 + (optDownload?1:0) + (optFolder?1:0) + (optNotes?1:0) + (optUrl?1:0);

  var lastCol  = Math.max(sheet.getLastColumn(), 1);
  var row1vals = sheet.getRange(1, 1, 1, lastCol).getValues().shift();
  var foundCol = -1;
  for (var i = 0; i < row1vals.length; i++) {
    if (row1vals[i].toString().trim() === category) { foundCol = i + 1; break; }
  }

  var C;

  if (foundCol !== -1) {
    C = foundCol;
    sheet.getRange(2, C, 1, TRACK_COLS).insertCells(SpreadsheetApp.Dimension.ROWS);
  } else {
    C = row1vals.some(function(v){ return v !== ""; }) ? lastCol + 2 : 1;
    sheet.getRange(1, C).setValue(sheetText(category)).setFontWeight("bold");

    var colOffset = 0;
    sheet.setColumnWidth(C + colOffset, 90);  colOffset++;
    sheet.setColumnWidth(C + colOffset, 160); colOffset++;
    if (optDownload) { sheet.setColumnWidth(C + colOffset, 110); colOffset++; }
    if (optFolder)   { sheet.setColumnWidth(C + colOffset, 110); colOffset++; }
    if (optNotes)    { sheet.setColumnWidth(C + colOffset, 160); colOffset++; }
    if (optUrl)      { sheet.setColumnWidth(C + colOffset, 110); colOffset++; }
  }

  sheet.setRowHeight(2, 160);
  writeRow(sheet, 2, C, dateStr, videoUrl, imageUrlForSheet,
           downloadUrl, folderUrl, notes, optDownload, optFolder, optNotes, optUrl);
}

// ── 横排：写一列多行 ──────────────────────────────────────────
function writeCard(sheet, startRow, col, dateStr, videoUrl, imageUrlForSheet,
                   downloadUrl, folderUrl, notes,
                   optDownload, optFolder, optNotes, optUrl) {
  var row = startRow;
  sheet.getRange(row, col).setValue(dateStr).setFontWeight("bold"); row++;
  sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(videoUrl) + '",IMAGE("' + formulaString(imageUrlForSheet) + '"))'); row++;
  if (optDownload) { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(downloadUrl) + '","📥 下载图片")'); row++; }
  if (optFolder)   { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(folderUrl) + '","📂 打开位置")'); row++; }
  if (optNotes)    { sheet.getRange(row, col).setValue(sheetText(notes)); row++; }
  if (optUrl)      { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(videoUrl) + '","🔗 来源链接")'); }
}

// ── 竖排：写一行多列 ──────────────────────────────────────────
function writeRow(sheet, row, startCol, dateStr, videoUrl, imageUrlForSheet,
                  downloadUrl, folderUrl, notes,
                  optDownload, optFolder, optNotes, optUrl) {
  var col = startCol;
  sheet.getRange(row, col).setValue(dateStr).setFontWeight("bold"); col++;
  sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(videoUrl) + '",IMAGE("' + formulaString(imageUrlForSheet) + '"))'); col++;
  if (optDownload) { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(downloadUrl) + '","📥 下载图片")'); col++; }
  if (optFolder)   { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(folderUrl) + '","📂 打开位置")'); col++; }
  if (optNotes)    { sheet.getRange(row, col).setValue(sheetText(notes)); col++; }
  if (optUrl)      { sheet.getRange(row, col).setFormula('=HYPERLINK("' + formulaString(videoUrl) + '","🔗 来源链接")'); }
}

// ── A1 索引存取 ───────────────────────────────────────────────
function saveIndex(cell, indexMap) {
  var lines = [];
  Object.keys(indexMap).forEach(function(key) { lines.push(key + "|" + indexMap[key]); });
  cell.setValue(sheetText(lines.join("\n"))).setFontColor("#ffffff").setFontSize(7);
}

// ── ID 提取 ───────────────────────────────────────────────────
function extractId(input) {
  if (!input) return "";
  input = input.trim();
  if (input.indexOf("http") === 0) {
    var parts = input.split("/");
    var found = "";
    parts.forEach(function(item) {
      var clean = item.split("?").shift();
      if (clean.length >= 25 && clean.length <= 60) found = clean;
    });
    if (found) return found;
  }
  return input.split("?").shift();
}

// 仅将预期字段用于资源操作，避免公式注入、索引污染和超大请求。
function validateUpload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请求无效");
  function text(name, max, required) {
    var value = data[name];
    if (value == null && !required) return;
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
      throw new Error("字段无效：" + name);
    }
  }
  text("sheetId", 2048, true); text("folderId", 2048, true);
  text("imgBase64", 14 * 1024 * 1024, true);
  if (!/^(?:data:image\/jpeg;base64,)?[A-Za-z0-9+/]+={0,2}$/.test(data.imgBase64)) throw new Error("图片格式无效");
  text("date", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error("日期格式无效");
  text("category", 200, false);
  if (data.category && /[|\r\n]/.test(data.category)) throw new Error("分类不能包含换行或竖线");
  text("notes", 40000, false); text("videoTitle", 2000, false);
  text("folderName", 200, false); text("sheetName", 100, false); text("platform", 100, false);
  text("videoUrl", 4096, false);
  if (data.videoUrl && !/^https?:\/\/[^\s\x00-\x1f\x7f]+$/i.test(data.videoUrl)) throw new Error("来源链接必须为 HTTP(S)");
  if (data.layoutMode != null && data.layoutMode !== "horizontal" && data.layoutMode !== "vertical") throw new Error("排列方式无效");
  ["optDownload", "optFolder", "optNotes", "optUrl"].forEach(function(name) {
    if (data[name] != null && typeof data[name] !== "boolean") throw new Error("选项无效");
  });
}

// Sheets 将以 = 开头的 setValue 字符串解释为公式；文本必须保持字面含义。
function sheetText(value) {
  var text = String(value == null ? "" : value);
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
}

// Google Sheets 公式中的双引号必须加倍，不能使用 JavaScript 反斜杠转义。
function formulaString(value) {
  return String(value).replace(/"/g, '""');
}
