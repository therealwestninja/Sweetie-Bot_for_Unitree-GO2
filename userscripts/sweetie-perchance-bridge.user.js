// ==UserScript==
// @name         Sweetie Perchance Bridge
// @namespace    sweetie
// @version      1.0
// @description  Bridges a Perchance AI-text generator tab to the sweetie server so Perchance can serve as Sweetie's fallback conversational AI when no Anthropic key is set. Long-polls the server, runs prompts through the page's aiTextPlugin, posts completions back.
// @match        https://perchance.org/*
// @match        https://*.perchance.org/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/*
 * SETUP
 *   1. Open a Perchance generator that exposes an AI text plugin (the
 *      "ai-text-plugin" / pocket-companion style generator) in a tab.
 *   2. Set SERVER below to your sweetie server origin (default localhost:8000).
 *   3. Run sweetie with no ANTHROPIC_API_KEY. Sweetie's chat() will hand
 *      conversational prompts to this tab and speak the Perchance reply.
 *
 * This is a *fallback* path: Perchance does plain text generation (no tools),
 * so it powers conversation only — autonomy/tool turns require Anthropic.
 */

(function () {
  "use strict";

  var SERVER = "http://localhost:8000";
  var POLL_PATH = "/api/perchance/poll";
  var COMPLETE_PATH = "/api/perchance/complete";
  var FAIL_PATH = "/api/perchance/fail";
  var IDLE_BACKOFF_MS = 800;   // after a 204 (no work)
  var ERROR_BACKOFF_MS = 3000; // after a network error

  function gm(method, path, body) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: SERVER + path,
        headers: { "Content-Type": "application/json" },
        data: body ? JSON.stringify(body) : undefined,
        onload: function (r) { resolve(r); },
        onerror: function (e) { reject(e); },
        ontimeout: function () { reject(new Error("timeout")); }
      });
    });
  }

  // Locate the page's AI text plugin. Perchance generators expose it in a few
  // shapes depending on the generator; try the known ones (pocket-companion
  // idiom). Returns a function(prompt) -> Promise<string>.
  function getAiRunner() {
    var ai =
      (typeof window.aiTextPlugin !== "undefined" && window.aiTextPlugin) ||
      (window.parent && window.parent.aiTextPlugin) ||
      (window.root && window.root.aiTextPlugin) ||
      null;
    if (!ai) return null;

    return function (prompt) {
      // Prefer a non-streaming getResponse; fall back to startStream; finally
      // to a raw call returning an object with .generatedText / .text.
      try {
        if (typeof ai.getResponse === "function") {
          return Promise.resolve(ai.getResponse(prompt)).then(unwrap);
        }
        if (typeof ai.startStream === "function") {
          return new Promise(function (resolve) {
            var acc = "";
            ai.startStream(prompt, function (chunk) {
              if (chunk == null) resolve(acc);
              else acc += String(chunk);
            });
          });
        }
        if (typeof ai === "function") {
          return Promise.resolve(ai(prompt)).then(unwrap);
        }
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.reject(new Error("no usable aiTextPlugin method"));
    };
  }

  function unwrap(r) {
    if (r == null) return "";
    if (typeof r === "string") return r;
    // boxed String or result object
    if (typeof r.generatedText !== "undefined") return String(r.generatedText);
    if (typeof r.text !== "undefined") return String(r.text);
    return String(r);
  }

  var runner = null;

  async function loop() {
    for (;;) {
      try {
        if (!runner) {
          runner = getAiRunner();
          if (!runner) {
            // Plugin not ready yet (or wrong page) — wait and retry.
            await sleep(ERROR_BACKOFF_MS);
            continue;
          }
        }
        var res = await gm("GET", POLL_PATH);
        if (res.status === 204) { await sleep(IDLE_BACKOFF_MS); continue; }
        if (res.status !== 200) { await sleep(ERROR_BACKOFF_MS); continue; }

        var job = JSON.parse(res.responseText);
        try {
          var text = await runner(job.prompt);
          await gm("POST", COMPLETE_PATH, { id: job.id, text: String(text || "").trim() });
        } catch (genErr) {
          await gm("POST", FAIL_PATH, { id: job.id, reason: String(genErr) });
        }
      } catch (netErr) {
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  console.log("[sweetie] Perchance bridge userscript active — server:", SERVER);
  loop();
})();
