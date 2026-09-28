const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

function extractFunction(source, name) {
  const match = source.match(new RegExp(`^\\s*function\\s+${name}\\s*\\(`, "m"));
  assert(match, `${name} must exist in agent.js`);
  const start = source.indexOf("{", match.index + match[0].length);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(character)) quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Unclosed function: ${name}`);
}

function extractTopLevelFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const nextStart = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextStart === -1 ? source.length : nextStart);
}

const agentSource = fs.readFileSync("agent.js", "utf8");
assert(!/if\s*\(\s*Array\.isArray\(learningLogCache\)\s*\)\s*return\s+learningLogCache\s*;/.test(agentSource), "loadLearningLog stale-cache guard");
assert(agentSource.includes("primary-content-change-fallback"), "URL content fallback guard");
assert(agentSource.includes("Interactive CAPTCHA detected on first check"), "interactive CAPTCHA handoff guard");
const hrefFilterPosition = agentSource.indexOf("const hrefMatchedCandidates = hrefNeedles.length");
const candidateLimitPosition = agentSource.indexOf("const candidateLimit =", hrefFilterPosition - 500);
assert(hrefFilterPosition > candidateLimitPosition, "href filtering happens before candidate truncation");

const names = [
  "getHostFromUrl", "hostMatchesExpectedHost", "detectStuck", "mapKnownHostTypos", "sanitizeNavigationUrl",
  "extractUrlFromText", "extractExplicitNavigationTarget", "inferKnownSiteTarget", "resolveDirectNavigationTarget",
  "isGoogleSearchResultsUrl", "isDuckDuckGoSearchResultsUrl", "buildSearchResultsUrl", "sanitizeExtractedSearchQuery", "extractSearchQuery",
  "shouldResetTaskContextToSearchEngine",
  "inferPageTypeFromUrl", "buildInstinctEvidenceBundle", "formatInstinctEvidencePacket",
  "isMapsLikeUrl", "isActionFailureStatus", "isEscapeManagedActionName", "computePlanSignature",
  "actionEntersMaps", "clamp01", "visionRiskValue", "planRiskValue"
];
const context = {
  URL,
  console,
  SIMPLE_BROWSING_MODE: "auto",
  actionEntersMaps: undefined
};
vm.createContext(context);
const blocks = names.map(name => ["buildInstinctEvidenceBundle", "formatInstinctEvidencePacket"].includes(name)
  ? extractTopLevelFunction(agentSource, name)
  : extractFunction(agentSource, name));
vm.runInContext(`${blocks.join("\n")}\nthis.exports = { ${names.map(name => `${name}: ${name}`).join(", ")} };`, context);
const fn = context.exports;

function check(condition, message) {
  assert(condition, message);
  process.stdout.write(`ok - ${message}\n`);
}

check(fn.getHostFromUrl("https://www.google.com/search") === "google.com", "www host normalization");
check(fn.hostMatchesExpectedHost("evilgoogle.com", "google.com") === false, "host boundary matching");
check(fn.hostMatchesExpectedHost("docs.google.com", "google.com") === true, "subdomain matching");
check(fn.sanitizeNavigationUrl("https://node.js/").includes("nodejs.org"), "known host typo mapping");
check(fn.sanitizeNavigationUrl("javascript:alert(1)") === null, "unsafe navigation rejection");
check(fn.resolveDirectNavigationTarget("open github and find playwright") === "https://github.com/", "known-site direct navigation");
check(fn.resolveDirectNavigationTarget("search DuckDuckGo for playwright") === "https://duckduckgo.com/", "explicit DuckDuckGo navigation");
check(fn.isGoogleSearchResultsUrl("https://www.google.com/sorry/index") === false, "captcha page is not search results");
check(fn.isDuckDuckGoSearchResultsUrl("https://duckduckgo.com/?q=playwright") === true, "DuckDuckGo results detection");
check(fn.buildSearchResultsUrl("hello world") === "https://duckduckgo.com/?q=hello%20world", "DuckDuckGo default search URL encoding");
check(fn.buildSearchResultsUrl("hello world", "google") === "https://www.google.com/search?q=hello%20world", "explicit Google search URL");
check(fn.buildSearchResultsUrl("hello world", "bing") === "https://www.bing.com/search?q=hello%20world", "explicit Bing search URL");
check(fn.shouldResetTaskContextToSearchEngine({ url: "https://duckduckgo.com/?q=playwright" }, { query: "playwright" }, false) === false, "DuckDuckGo preserves active search context");
check(fn.shouldResetTaskContextToSearchEngine({ url: "https://www.google.com/search?q=playwright" }, { query: "playwright" }, false) === true, "generic search leaves persisted Google context");
check(fn.shouldResetTaskContextToSearchEngine({ url: "https://www.google.com/search?q=playwright" }, { query: "playwright", targetHost: "google.com" }, false) === false, "explicit Google task preserves Google context");
const instinctBundle = fn.buildInstinctEvidenceBundle(
  "Find where I live",
  {
    url: "https://duckduckgo.com/",
    title: "DuckDuckGo Search Engine",
    text: "Welcome to DuckDuckGo. Search the web privately.",
    links: [{ text: "Images", href: "https://duckduckgo.com/?iax=images" }],
    inputs: [{ placeholder: "Search the web", type: "search", selector: "input[name=q]" }],
    buttons: [{ text: "Search", selector: "button[type=submit]" }],
    voidMapClickable: ["input Search the web"]
  },
  "Search engine homepage with one visible search field",
  ["Step 1: loaded DuckDuckGo"],
  {
    elementMap: { summary: "One visible input control", clickable: [{ tag: "input", text: "Search the web", selector: "input[name=q]" }] },
    strider: "DuckDuckGo homepage has a search form",
    memory: { results: [{ summary: "Previous task used the search field", url: "https://duckduckgo.com/" }] },
    vision: { results: [{ summary: "A centered search bar is visible" }] }
  },
  { currentSubtask: "Locate the search bar", stepCount: 0 },
  { subgoals: [{ kind: "research", target: "Find where I live", done: false }] }
);
check(instinctBundle.currentSubtask === "Locate the search bar", "Instinct receives the Planner's active subtask");
check(instinctBundle.pageClassification === "search_engine_homepage", "Instinct distinguishes a search homepage");
check(instinctBundle.goalProgress.percent === 0 && instinctBundle.subtaskStatus === "not_started", "Instinct reports goal and subtask progress");
check(instinctBundle.fallbackRelevantEvidence[0].type === "input", "fallback evidence ranking prioritizes the matching search input");
for (const source of ["vision", "element_map", "strider", "memory", "task_log"]) {
  check(instinctBundle.evidenceCatalog.some(item => item.source === source), `evidence catalog includes ${source}`);
}
const instinctReportText = fn.formatInstinctEvidencePacket({
  ...instinctBundle,
  relevantAnchors: [{ text: "Search the web", href: "https://duckduckgo.com/", selector: "input[name=q]", confidence: 0.99, why: "matches the active subtask" }],
  nearbyContext: [{ text: "DuckDuckGo homepage", why: "contains the search field" }],
  competingCandidates: [{ text: "Images link", reasonRejected: "opens image search, not the search input" }],
  rejectedEvidence: [{ text: "Images link", reasonRejected: "opens image search, not the search input" }],
  evidenceStrength: "very_high",
  evidenceGaps: []
});
check(instinctReportText.includes("Relevant Anchors:") && instinctReportText.includes("Competing Candidates:"), "Instinct renders a structured evidence report");
check(!/Recommended Action|Focus on the current page state/i.test(instinctReportText), "Instinct report contains no action recommendation or filler");
check(fn.detectStuck(["x: click:a — fail", "x: click:b — fail", "x: click:a — fail", "x: click:b — fail"]) === false, "four entries are not enough for alternating loop");
check(fn.detectStuck(["x: click:a — fail", "x: click:b — fail", "x: click:a — fail", "x: click:b — fail", "x: click:a — fail", "x: click:b — fail"]) === true, "A-B-A-B alternating loop");
check(fn.detectStuck(["x: a — fail", "x: b — fail", "x: c — fail", "x: d — fail", "x: e — fail", "x: f — fail"]) === false, "distinct actions are not stuck");
check(fn.isActionFailureStatus("blocked") === true && fn.isActionFailureStatus("ok") === false, "failure status classification");
check(fn.clamp01(4) === 1 && fn.clamp01(-1) === 0, "risk clamp");
check(fn.planRiskValue([{ action: "evaluate" }]) > fn.planRiskValue([{ action: "getAllText" }]), "riskier action scores higher");

console.log("Smoke test passed");
