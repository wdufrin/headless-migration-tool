
function sendLog(text, level = "info") {
  console.log("[Migration Companion]", text);
  try {
    chrome.runtime.sendMessage({ type: "COMPANION_LOG", text, level });
  } catch (err) {
    console.debug("[Migration Companion] Extension background port unavailable:", err);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractConfigId() {
  const m = window.location.href.match(/cid\/([a-zA-Z0-9-]+)/);
  return m ? m[1] : "";
}

function extractApiKey() {
  // Check performance entries or scripts for API key
  const entries = performance.getEntriesByType("resource");
  for (const r of entries) {
    if (r.name.includes("key=")) {
      const match = r.name.match(/key=([^&]+)/);
      if (match) return match[1];
    }
  }
  return "";
}

function findDraftAgentIds() {
  const cards = Array.from(document.querySelectorAll("mat-card, div.agent-card, [role='listitem'], div"));
  const draftMap = new Map();

  for (const card of cards) {
    if (card.children.length > 0 && card.innerText && card.innerText.includes("Draft")) {
      // Find title
      const titleEl = card.querySelector("h3, .title, .font-medium, div");
      const title = titleEl ? titleEl.innerText.split("\n")[0] : "Agent";

      // Look for agent ID in links, attributes, or text
      const html = card.innerHTML;
      const idMatch = html.match(/agents?\/([0-9]{10,25})/);
      if (idMatch) {
        draftMap.set(idMatch[1], title);
      } else {
        // Find anchor tag
        const a = card.querySelector("a[href*='agent']");
        if (a) {
          const aId = a.href.match(/agent[s]?\/([0-9]{10,25})/);
          if (aId) draftMap.set(aId[1], title);
        }
      }
    }
  }
  return draftMap;
}

async function deployAgentDirectApi(agentId, configId, apiKey) {
  const url = "https://discoveryengine.clients6.google.com/v1alpha/locations/global/widgetDeployLowCodeAgent?key=" + apiKey;
  const payload = {
    configId: configId,
    additionalParams: { token: "-", origin: "LOW_CODE_AGENT" },
    deployLowCodeAgentRequest: { name: agentId, deployMode: "DEPLOY" },
    location: "global"
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("HTTP " + res.status + ": " + errText);
  }
  return await res.json();
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === "SCAN_DRAFTS") {
    const draftMap = findDraftAgentIds();
    const count = draftMap.size;
    sendLog("Detected " + count + " draft agents on screen ready for direct API deploy.", "info");
    sendResponse({ count });
    return true;
  }

  if (req.action === "PUBLISH_DRAFTS") {
    (async () => {
      const configId = extractConfigId();
      const apiKey = extractApiKey();
      const draftMap = findDraftAgentIds();

      sendLog("Using Config ID: " + configId, "info");
      sendLog("Found " + draftMap.size + " draft agents. Executing direct high-speed Google internal API deploys...", "info");

      let processed = 0;
      let failed = 0;

      // If IDs were found directly on screen:
      if (draftMap.size > 0) {
        for (const [agentId, title] of draftMap.entries()) {
          try {
            sendLog("Deploying " + title + " (ID: " + agentId + ")...", "info");
            await deployAgentDirectApi(agentId, configId, apiKey);
            processed++;
            sendLog("✅ Deployed: " + title, "success");
          } catch (err) {
            sendLog("⚠️ Direct deploy error for " + title + ": " + err.message, "warn");
            failed++;
          }
          await sleep(200);
        }
      } else {
        // Fallback to DOM Click Automation if IDs are obscured
        sendLog("Obscured DOM detected, falling back to UI click sequence...", "info");
        const cards = Array.from(document.querySelectorAll("mat-card, [role='listitem'], div")).filter(c => c.innerText && c.innerText.includes("Draft"));
        for (const card of cards) {
          const title = card.innerText.split("\n")[0] || "Agent";
          sendLog("Opening: " + title, "info");
          card.click();
          await sleep(2000);
          const deployBtn = Array.from(document.querySelectorAll("button, [role='button']")).find(b => (b.innerText || "").toLowerCase().includes("deploy") || (b.innerText || "").toLowerCase().includes("publish"));
          if (deployBtn) {
            deployBtn.click();
            await sleep(2000);
            processed++;
            sendLog("✅ Published: " + title, "success");
          }
          window.history.back();
          await sleep(1500);
        }
      }

      sendLog("🎉 High-speed bulk publishing finished! Success: " + processed + ", Errors: " + failed, "success");
      sendResponse({ success: true, processed, failed });
      
      // Auto-reload to reflect green / deployed cards
      setTimeout(() => { window.location.reload(); }, 2000);
    })();
    return true;
  }
});
