/* 客户端签名更新与官网展示独立发布。 */
async function loadClientUpdateCard(host) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.marginTop = "14px";
  host.prepend(card);
  let r;
  try { r = await api("/admin-api/client-update"); }
  catch (e) { card.textContent = "客户端更新配置读取失败：" + e.message; return; }
  card.innerHTML = `<div class="hd"><h3>客户端自动更新</h3><span class="badge">${esc(r.release?.version || "尚未发布")}</span></div>
    <div class="bd">
      <p class="mut">客户端自动下载，用户点击「保存并重启安装」后更新。选择同一次正式打包目录中的 update-release.json 和 .exe；服务器验签通过后才推送。</p>
      <div class="fld"><span>更新发布文件（update-release.json）</span><input data-release type="file" accept=".json" /></div>
      <div class="fld"><span>Windows 安装包（.exe）</span><input data-installer type="file" accept=".exe" /></div>
      <div class="fld"><span>本次更新说明</span><textarea data-notes rows="3" placeholder="一行一条，用户下载后可查看"></textarea></div>
      <div class="toolbar"><button class="pri" data-publish>上传、验签并发布更新</button><span data-status class="mut" role="status"></span></div>
      <p class="mut">当前更新地址：${esc(r.feedUrl)}<br>首次使用需安装支持自动更新的 v2.0.1 或更高版本。旧版 v2.0.0 须手动安装一次。</p>
    </div>`;
  const button = card.querySelector("[data-publish]");
  const status = card.querySelector("[data-status]");
  button.onclick = async () => {
    const descriptor = card.querySelector("[data-release]").files[0];
    const file = card.querySelector("[data-installer]").files[0];
    if (!descriptor || !file) { status.textContent = "请先选择发布文件和安装包"; return; }
    button.disabled = true;
    try {
      const d = JSON.parse((await descriptor.text()).replace(/^\uFEFF/, ""));
      if (!d.version || !d.signature || d.filename !== file.name || d.feedUrl !== r.feedUrl) throw new Error("发布文件与安装包或更新地址不匹配");
      status.textContent = `正在上传 v${d.version}…`;
      const p = await api("/admin-api/site/installer/presign", { method: "POST", body: JSON.stringify({ filename: file.name, clientUpdate: true }) });
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", p.putUrl);
        xhr.setRequestHeader("Content-Type", p.contentType);
        xhr.timeout = 2 * 60 * 60_000;
        xhr.upload.onprogress = e => { if (e.lengthComputable) status.textContent = `上传 ${Math.round(e.loaded / e.total * 100)}%`; };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("安装包上传失败"));
        xhr.onerror = () => reject(new Error("上传网络错误"));
        xhr.ontimeout = () => reject(new Error("上传超时"));
        xhr.send(file);
      });
      status.textContent = "正在验证安装包签名并发布，请稍候…";
      const published = await api("/admin-api/client-update", { method: "POST", body: JSON.stringify({
        version: d.version, signature: d.signature, url: p.publicUrl, notes: card.querySelector("[data-notes]").value,
      }) });
      r = published;
      card.querySelector(".badge").textContent = published.release.version;
      status.textContent = `v${published.release.version} 已发布，客户端下次检查时自动下载`;
    } catch (e) { status.textContent = "发布失败：" + e.message; }
    finally { button.disabled = false; }
  };
}
