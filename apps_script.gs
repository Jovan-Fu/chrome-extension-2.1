// ============================================================
//  智能截图助手 Pro v2.2 — Google Apps Script
//  部署方式：Extensions → Apps Script → 粘贴代码 → 部署为 Web 应用
//  执行身份：以我自己身份执行
//  访问权限：所有人（含匿名用户）
// ============================================================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

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

    // ── 配合 GCP 服务账号凭证：自动授权与访问受限文档 ───────────
    var sa = data.serviceAccount;
    var saToken = null;
    if (sa && sa.client_email && sa.private_key) {
      try {
        saToken = getServiceAccountAccessToken_(sa);
        var deployerEmail = "";
        try { deployerEmail = Session.getEffectiveUser().getEmail(); } catch(e) {}
        if (deployerEmail) {
          grantDrivePermission_(parentFolderId, deployerEmail, saToken, "writer");
          grantDrivePermission_(sheetId, deployerEmail, saToken, "writer");
        }
      } catch (saErr) {
        console.log("服务账号授权记录: " + saErr.message);
      }
    }

    // 1. 处理网盘文件夹与上传图片
    var fileId = "";
    var videoFolderId = "";
    var decodedImg = Utilities.base64Decode(base64Data);
    var timestamp  = Utilities.formatDate(new Date(), "GMT+8", "HH-mm-ss");
    var fileName   = platform + "_截图_" + timestamp + ".jpg";

    var rootFolder = null;
    try {
      rootFolder = DriveApp.getFolderById(parentFolderId);
    } catch(err) {
      if (!saToken) {
        throw new Error("无法打开网盘文件夹：" + err.message + "。若为受限网盘，请在插件配置 GCP 服务账号并在网盘添加协作者");
      }
    }

    if (rootFolder) {
      // 原生 DriveApp 路径
      var dateFolders = rootFolder.getFoldersByName(dateStr);
      var dateFolder  = dateFolders.hasNext() ? dateFolders.next() : rootFolder.createFolder(dateStr);

      var videoFolders = dateFolder.getFoldersByName(folderName);
      var videoFolder  = videoFolders.hasNext() ? videoFolders.next() : dateFolder.createFolder(folderName);
      videoFolderId    = videoFolder.getId();

      var file = videoFolder.createFile(Utilities.newBlob(decodedImg, "image/jpeg", fileName));
      fileId   = file.getId();
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
      catch(e) {
        if (saToken) grantDrivePermission_(fileId, "", saToken, "reader");
        console.log("分享权限受限：" + e.message);
      }
    } else {
      // 受限模式：通过服务账号 Token 经由 REST API 处理
      var dateFolderId = getOrCreateFolderWithToken_(parentFolderId, dateStr, saToken);
      videoFolderId    = getOrCreateFolderWithToken_(dateFolderId, folderName, saToken);
      fileId           = uploadFileWithToken_(videoFolderId, decodedImg, fileName, saToken);
    }

    var imageUrlForSheet = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w400";
    var downloadUrl      = "https://drive.google.com/uc?export=download&id=" + fileId;
    var folderUrl        = "https://drive.google.com/drive/folders/" + videoFolderId;

    // 2. 打开表格，定位 Sheet
    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
      hasLock = lock.tryLock(30000); // 并发排队等待最多30秒
    } catch(e) {}

    try {
      var ss;
      try {
        ss = SpreadsheetApp.openById(sheetId);
      } catch(err) {
        var hint = (sa && sa.client_email)
          ? "。请确保在受限表格「共享」中已将服务账号邮箱「" + sa.client_email + "」添加为「编辑器」"
          : "。若为受限表格，请在插件中配置 GCP 服务账号 JSON 并在表格中添加协作者";
        throw new Error("无法打开谷歌表格：" + err.message + hint);
      }

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
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
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
  var indexMap   = {};
  if (indexRaw.trim() !== "") {
    indexRaw.split("\n").forEach(function(line) {
      var parts = line.split("|");
      if (parts.length === 2 && !isNaN(parseInt(parts[1]))) {
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
    sheet.getRange(R, 1).setValue(category).setFontWeight("bold");
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
    sheet.getRange(1, C).setValue(category).setFontWeight("bold");

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
  sheet.getRange(row, col).setFormula('=HYPERLINK("' + videoUrl + '",IMAGE("' + imageUrlForSheet + '"))'); row++;
  if (optDownload) { sheet.getRange(row, col).setFormula('=HYPERLINK("' + downloadUrl + '","📥 下载图片")'); row++; }
  if (optFolder)   { sheet.getRange(row, col).setFormula('=HYPERLINK("' + folderUrl   + '","📂 打开位置")'); row++; }
  if (optNotes)    { sheet.getRange(row, col).setValue(notes); row++; }
  if (optUrl)      { sheet.getRange(row, col).setFormula('=HYPERLINK("' + videoUrl    + '","🔗 来源链接")'); }
}

// ── 竖排：写一行多列 ──────────────────────────────────────────
function writeRow(sheet, row, startCol, dateStr, videoUrl, imageUrlForSheet,
                  downloadUrl, folderUrl, notes,
                  optDownload, optFolder, optNotes, optUrl) {
  var col = startCol;
  sheet.getRange(row, col).setValue(dateStr).setFontWeight("bold"); col++;
  sheet.getRange(row, col).setFormula('=HYPERLINK("' + videoUrl + '",IMAGE("' + imageUrlForSheet + '"))'); col++;
  if (optDownload) { sheet.getRange(row, col).setFormula('=HYPERLINK("' + downloadUrl + '","📥 下载图片")'); col++; }
  if (optFolder)   { sheet.getRange(row, col).setFormula('=HYPERLINK("' + folderUrl   + '","📂 打开位置")'); col++; }
  if (optNotes)    { sheet.getRange(row, col).setValue(notes); col++; }
  if (optUrl)      { sheet.getRange(row, col).setFormula('=HYPERLINK("' + videoUrl    + '","🔗 来源链接")'); }
}

// ── A1 索引存取 ───────────────────────────────────────────────
function saveIndex(cell, indexMap) {
  var lines = [];
  Object.keys(indexMap).forEach(function(key) { lines.push(key + "|" + indexMap[key]); });
  cell.setValue(lines.join("\n")).setFontColor("#ffffff").setFontSize(7);
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

// ============================================================
//  GCP 服务账号 (Service Account JSON) 授权与受限文档处理
// ============================================================

/**
 * 使用服务账号私钥通过 RSA-SHA256 生成 JWT 并换取 Google OAuth2 Access Token
 */
function getServiceAccountAccessToken_(sa) {
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: "RS256", typ: "JWT" };
  var claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  var base64Header = Utilities.base64EncodeWebSafe(JSON.stringify(header));
  var base64Claim = Utilities.base64EncodeWebSafe(JSON.stringify(claim));
  var signInput = base64Header + "." + base64Claim;

  var privateKey = (sa.private_key || "").replace(/\\n/g, "\n");
  var signature = Utilities.computeRsaSha256Signature(signInput, privateKey);
  var base64Sig = Utilities.base64EncodeWebSafe(signature);
  var jwt = signInput + "." + base64Sig;

  var resp = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  var json = JSON.parse(resp.getContentText());
  if (json.access_token) {
    return json.access_token;
  }
  throw new Error("GCP 服务账号授权失败：" + (json.error_description || json.error || resp.getContentText()));
}

/**
 * 通过服务账号 Token 为指定用户或公开设置云端文件/文件夹权限
 */
function grantDrivePermission_(fileId, email, token, role) {
  if (!fileId || !token) return;
  try {
    var url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "/permissions?supportsAllDrives=true";
    var payload = email ? {
      role: role || "writer",
      type: "user",
      emailAddress: email
    } : {
      role: role || "reader",
      type: "anyone"
    };
    UrlFetchApp.fetch(url, {
      method: "post",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch(e) {
    console.log("权限开通记录: " + e.message);
  }
}

/**
 * 在受限状态下通过 Token 查找或创建云端文件夹
 */
function getOrCreateFolderWithToken_(parentId, folderName, token) {
  var q = "'" + parentId + "' in parents and name = '" + folderName.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  var searchUrl = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) + "&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)";
  var res = UrlFetchApp.fetch(searchUrl, {
    headers: { "Authorization": "Bearer " + token },
    muteHttpExceptions: true
  });
  var json = JSON.parse(res.getContentText());
  if (json.files && json.files.length > 0) {
    return json.files[0].id;
  }
  var createUrl = "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true";
  var createRes = UrlFetchApp.fetch(createUrl, {
    method: "post",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    }),
    muteHttpExceptions: true
  });
  var created = JSON.parse(createRes.getContentText());
  if (created.id) return created.id;
  throw new Error("创建受限网盘文件夹失败：" + (created.error ? created.error.message : createRes.getContentText()));
}

/**
 * 在受限状态下通过 Token 将图片上传至指定文件夹
 */
function uploadFileWithToken_(folderId, decodedBytes, fileName, token) {
  var boundary = "-------314159265358979323846";
  var delimiter = "\r\n--" + boundary + "\r\n";
  var closeDelim = "\r\n--" + boundary + "--";

  var metadata = {
    name: fileName,
    parents: [folderId]
  };

  var base64Data = Utilities.base64Encode(decodedBytes);

  var multipartBody =
    delimiter +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    delimiter +
    "Content-Type: image/jpeg\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    base64Data +
    closeDelim;

  var uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
  var uploadRes = UrlFetchApp.fetch(uploadUrl, {
    method: "post",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    payload: multipartBody,
    muteHttpExceptions: true
  });
  var fileInfo = JSON.parse(uploadRes.getContentText());
  if (fileInfo.id) {
    grantDrivePermission_(fileInfo.id, "", token, "reader");
    return fileInfo.id;
  }
  throw new Error("上传图片至受限网盘失败：" + (fileInfo.error ? fileInfo.error.message : uploadRes.getContentText()));
}
