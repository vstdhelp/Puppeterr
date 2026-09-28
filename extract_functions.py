import re

with open("agent.js", encoding="utf-8") as handle:
    content = handle.read()

TARGETS = [
    "getHostFromUrl", "hostMatchesExpectedHost", "detectStuck", "looksLikeTaskGoal",
    "sanitizeTaskGoal", "extractUrlFromText", "mapKnownHostTypos", "sanitizeNavigationUrl",
    "extractExplicitNavigationTarget", "inferKnownSiteTarget", "resolveDirectNavigationTarget",
    "isGoogleSearchResultsUrl", "buildSearchResultsUrl", "sanitizeExtractedSearchQuery",
    "extractSearchQuery", "getExplicitSearchEnginePreference", "isSearchEngineComparisonGoal",
    "isMapsLikeUrl", "isActionFailureStatus", "isEscapeManagedActionName", "computePlanSignature",
    "actionEntersMaps", "clamp01", "instinctRiskValue", "visionRiskValue", "planRiskValue"
]


def extract_function(name):
    match = re.search(r"^\s*function\s+" + re.escape(name) + r"\s*\(", content, re.MULTILINE)
    if not match:
        print(f"WARNING: {name} not found")
        return None
    start = content.find("{", match.end())
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(content)):
        char = content[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return content[match.start():index + 1]
    raise ValueError(f"Unclosed function: {name}")


extracted = [block for name in TARGETS if (block := extract_function(name))]
with open("extracted_functions.js", "w", encoding="utf-8") as handle:
    handle.write("\n\n".join(extracted) + "\n")
print(f"Extracted {len(extracted)} functions")
