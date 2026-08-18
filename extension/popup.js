
function switchTab(tab) {
  document.getElementById("tabAgents").classList.toggle("active", tab === "agents");
  document.getElementById("tabStudio").classList.toggle("active", tab === "studio");
  document.getElementById("sectionAgents").style.display = tab === "agents" ? "block" : "none";
  document.getElementById("sectionStudio").style.display = tab === "studio" ? "block" : "none";
}

function log(msg, type = "info") {
  const box = document.getElementById("logBox");
  const div = document.createElement("div");
  div.className = "log-" + type;
  div.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("btnScanAgents").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("vertexaisearch.cloud.google.com")) {
    log("Please navigate to Gemini Enterprise Agent Gallery tab.", "warn");
    return;
  }
  log("Scanning page for draft agents...", "info");
  try {
    chrome.tabs.sendMessage(tab.id, { action: "SCAN_DRAFTS" }, (response) => {
      if (chrome.runtime.lastError) {
        log("Could not communicate with page. Please refresh the page.", "error");
        return;
      }
      if (response && response.count !== undefined) {
        log("Found " + response.count + " draft agent(s) on screen.", response.count > 0 ? "warn" : "success");
      }
    });
  } catch (e) {
    log("Scan error: " + e.message, "error");
  }
});

document.getElementById("btnPublishAgents").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("vertexaisearch.cloud.google.com")) {
    log("Please navigate to Gemini Enterprise Agent Gallery tab.", "warn");
    return;
  }
  const btn = document.getElementById("btnPublishAgents");
  btn.disabled = true;
  log("Starting automated bulk publishing...", "info");

  chrome.tabs.sendMessage(tab.id, { action: "PUBLISH_DRAFTS" }, (response) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      log("Connection failed: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (response && response.success) {
      log("Bulk publishing finished! Processed: " + (response.processed || 0), "success");
    } else {
      log("Publishing ended: " + (response?.message || "Check console"), "warn");
    }
  });
});

document.getElementById("btnSyncStudio").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url || (!tab.url.includes("vertexaisearch.cloud.google.com") && !tab.url.includes("notebooklm.google.com"))) {
    log("Please open a Notebook in Gemini Enterprise or NotebookLM.", "warn");
    return;
  }
  log("Triggering Studio Artifact recreation...", "info");
  chrome.tabs.sendMessage(tab.id, { action: "SYNC_STUDIO" }, (response) => {
    if (chrome.runtime.lastError) {
      log("Connection error: " + chrome.runtime.lastError.message, "error");
      return;
    }
    log(response?.message || "Studio trigger sent.", "success");
  });
});

// Listen for progress updates from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "COMPANION_LOG") {
    log(msg.text, msg.level || "info");
  }
});
