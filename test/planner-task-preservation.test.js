const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAgentComparisonFns() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');

  const extractFunction = (name) => {
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `missing function: ${name}`);
    const nextStart = source.indexOf('\nfunction ', start + 1);
    const end = nextStart === -1 ? source.length : nextStart;
    return source.slice(start, end);
  };

  const sandbox = {
    console,
    URL,
    VISION_STREAM_FRESH_MS: 15000,
    String,
    Number,
    Object,
    Array,
    Math,
    RegExp,
    Boolean,
    getHostFromUrl(rawUrl) {
      try {
        return new URL(String(rawUrl || '')).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    },
    extractUrlFromText(goalText) {
      const match = String(goalText || '').match(/https?:\/\/[^\s)]+/i);
      if (!match) return null;
      return String(match[0]).replace(/[\]\[)\('"`]+$/g, '').replace(/[.,;!?]+$/g, '');
    },
    buildSearchResultsUrl(queryText, engine = 'google') {
      const q = String(queryText || '').trim();
      if (!q) return engine === 'bing' ? 'https://www.bing.com/' : 'https://www.google.com/';
      if (engine === 'bing') return `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    },
    isGoogleSearchResultsUrl(rawUrl) {
      try {
        const parsed = new URL(String(rawUrl || ''));
        const host = parsed.hostname.toLowerCase();
        return (host === 'google.com' || host.endsWith('.google.com')) && parsed.pathname === '/search';
      } catch {
        return false;
      }
    },
    extractSearchQuery(goalText) {
      const g = String(goalText || '');
      const quoted = g.match(/"([^"]{2,120})"/);
      if (quoted) {
        let q = quoted[1].replace(/\s+/g, ' ').trim();
        q = q.split(/\b(?:then|and then|after that|afterwards|next|validate|verify|confirm)\b/i)[0].trim();
        q = q.replace(/\b(?:that|the|this|search|result|results|was|were|is|are|successful)\b\s*$/i, '').trim();
        q = q.replace(/[.,;:!?]+$/g, '').trim();
        return q.split(/\s+/).slice(0, 8).join(' ').trim();
      }
      const matches =
        g.match(/search\s+for\s+([^\n\.]{2,120})/i) ||
        g.match(/\bsearch\s+([^\n\.]{2,120})/i) ||
        g.match(/search\s+up\s+([^\n\.]{2,120})/i) ||
        g.match(/look\s+up\s+([^\n\.]{2,120})/i);
      if (!matches) return null;
      let q = matches[1].replace(/\s+/g, ' ').trim();
      q = q.split(/\b(?:then|and then|after that|afterwards|next|validate|verify|confirm)\b/i)[0].trim();
      q = q.replace(/\b(?:that|the|this|search|result|results|was|were|is|are|successful)\b\s*$/i, '').trim();
      q = q.replace(/[.,;:!?]+$/g, '').trim();
      return q.split(/\s+/).slice(0, 8).join(' ').trim() || null;
    },
    pickDocsLinkFromState() { return null; },
    resolveDirectNavigationTarget(goalText) {
      const explicitUrl = String(goalText || '').match(/https?:\/\/[^\s,]+/i)?.[0];
      return explicitUrl || (/imdb\.com/i.test(String(goalText || '')) ? 'https://www.imdb.com/' : '');
    },
    isExtractionSummaryGoal() { return false; },
    hostMatchesExpectedHost(host, expectedHost) {
      return !!host && !!expectedHost && (host === expectedHost || host.endsWith(`.${expectedHost}`));
    },
    getHostnameSafe(rawUrl) {
      try {
        return new URL(String(rawUrl || '')).hostname.toLowerCase();
      } catch {
        return '';
      }
    },
    extractExplicitNavigationTarget(goalText) {
      return String(goalText || '').match(/https?:\/\/[^\s)]+/i)?.[0] || null;
    },
    striderIntegration: {
      getReconReport() {
        return {
          ok: true,
          report: {
            topMatches: [{ domain: 'codepen.io', url: 'https://codepen.io/trending' }]
          }
        };
      }
    },
    formatStriderReconContext(report) {
      return report.topMatches.map(item => item.url).join('\n');
    },
    quoteCssText(value) {
      return `"${String(value).replace(/"/g, '\\"')}"`;
    }
  };

  vm.runInNewContext(
    [
      extractFunction('getExplicitSearchEnginePreference'),
      extractFunction('isSearchEngineComparisonGoal'),
      extractFunction('shouldUseHeuristicPlannerFallback'),
      extractFunction('preserveEvidenceText'),
      extractFunction('inferHeuristicPlan'),
      extractFunction('buildPlannerVisionContext'),
      extractFunction('splitBrowserTaskContext'),
      extractFunction('buildGoalMemory'),
      extractFunction('advanceGoalMemory'),
      extractFunction('nextGoalSubgoal'),
      extractFunction('isExtractionGoal'),
      extractFunction('buildStriderReconContext')
    ].join('\n\n'),
    sandbox
  );

  return sandbox;
}

test('reasoner keeps late evidence instead of dropping the final fact cluster', () => {
  const agent = loadAgentComparisonFns();
  const longText = 'A'.repeat(2000) + 'B'.repeat(1800) + 'NEEDED_FACT: 2026-09-08';
  const kept = agent.preserveEvidenceText(longText, 500);
  assert.match(kept, /NEEDED_FACT: 2026-09-08/);
  assert.ok(kept.length > 500);
});

test('heuristic fallback stays disabled for valid LLM output and only triggers on malformed or stuck recovery', () => {
  const agent = loadAgentComparisonFns();
  const goal = 'Search for "Jacksonville, FL" and compare results';
  const state = { url: 'https://www.google.com/search?q=Jacksonville%2C+FL' };

  assert.equal(agent.shouldUseHeuristicPlannerFallback({ done: false, actions: [] }, goal, state, ['Step 1: searched'], 0), false);
  assert.equal(agent.shouldUseHeuristicPlannerFallback({ done: false, actions: [], _parseFailed: true }, goal, state, ['Step 1: searched'], 0), true);
  assert.equal(agent.shouldUseHeuristicPlannerFallback({ done: false, actions: [] }, goal, state, ['Step 1: repeated fallback'], 4), true);
});

test('comparison planning keeps the explicit Bing task and compare intent intact', () => {
  const agent = loadAgentComparisonFns();
  const goal = 'On Bing Maps search for "Jacksonville, FL" then search the same thing on bing.com then compare and contrast';

  assert.equal(agent.isSearchEngineComparisonGoal(goal), true);

  const plan = agent.inferHeuristicPlan(goal, { url: 'about:blank' }, [], 0);
  assert.equal(plan.actions[0].action, 'goto');
  const url = new URL(String(plan.actions[0].params.url));
  assert.equal(url.origin, 'https://www.bing.com');
  assert.match(url.search, /\?q=Jacksonville%2C%20FL/i);
});

test('Instinct keeps evidence focused on the active destination instead of adding page-topic links', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const extractFunction = (name, isAsync = false) => {
    const declaration = `${isAsync ? 'async ' : ''}function ${name}`;
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `missing function: ${name}`);
    const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
    const nextAsyncFunction = source.indexOf('\nasync function ', start + declaration.length);
    const ends = [nextFunction, nextAsyncFunction].filter(index => index !== -1);
    const end = ends.length ? Math.min(...ends) : source.length;
    return source.slice(start, end);
  };
  const sandbox = {
    URL,
    inferPageTypeFromUrl: () => 'search_results',
    safeParseJSON: value => JSON.parse(value),
    getRuntimeTemperature: () => 0,
    REASONER_INSTINCT_PROMPT: 'test prompt',
    callCFAI: async (_model, messages) => {
      const catalogMatch = messages[1].content.match(/Evidence catalog[^\n]*:\n([\s\S]*?)\n\nReturn only/);
      assert.ok(catalogMatch, 'Instinct prompt should include its evidence catalog');
      const catalog = JSON.parse(catalogMatch[1]);
      const target = catalog.find(item => item.type === 'target_url');
      assert.ok(target, 'the explicit route should be included as target evidence');
      return JSON.stringify({
        relevantAnchorIds: [{ id: target.id, confidence: 1, why: 'Exact requested destination' }],
        nearbyContextIds: [],
        competingCandidateIds: [],
        evidenceStrength: 'high',
        evidenceGaps: []
      });
    }
  };
  vm.runInNewContext([
    extractFunction('buildInstinctEvidenceBundle'),
    extractFunction('getReasonerInstinct', true)
  ].join('\n\n'), sandbox);

  const report = await sandbox.getReasonerInstinct(
    'Find the Guardians of the Galaxy page on IMDb and read its plot',
    {
      url: 'https://www.imdb.com/find/',
      title: 'IMDb Search',
      text: 'Search IMDb for movies',
      links: [
        { text: 'IMDb Podcasts', href: 'https://www.imdb.com/podcasts/' },
        { text: 'Related title recommendations', href: 'https://www.imdb.com/chart/title-recommendations/' }
      ],
      inputs: [{ label: 'Search IMDb', name: 'q', type: 'text', selector: '#suggestion-search' }],
      buttons: []
    },
    '',
    [],
    { reasoner: 'mock' },
    {},
    {
      currentSubtask: 'Navigate to /title/tt2015381/',
      directNavigationTarget: 'https://www.imdb.com/title/tt2015381/'
    },
    null
  );

  assert.deepEqual(
    Array.from(report.relevantAnchors, item => item.href),
    ['https://www.imdb.com/title/tt2015381/']
  );
  assert.ok(!Array.from(report.relevantAnchors).some(item => /podcasts|recommendations/i.test(item.text)));
});

test('goal memory keeps director and biography stages pending until their evidence is reached', () => {
  const agent = loadAgentComparisonFns();
  const goal = 'On IMDb.com search for "Guardians of the Galaxy", then get the director\'s name and find his bio';
  const memory = agent.buildGoalMemory(goal);

  assert.deepEqual(Array.from(memory.subgoals, item => item.kind), ['navigate', 'search', 'identify', 'bio']);
  agent.advanceGoalMemory(memory, 'https://www.imdb.com/find/?q=Guardians%20of%20the%20Galaxy', []);
  assert.equal(agent.nextGoalSubgoal(memory).kind, 'identify');
  agent.advanceGoalMemory(memory, 'https://www.imdb.com/title/tt2015381/', [{
    status: 'ok',
    action: 'getAllText',
    extractedText: 'Guardians of the Galaxy. Director James Gunn.'
  }]);
  assert.equal(agent.nextGoalSubgoal(memory).kind, 'bio');

  agent.advanceGoalMemory(memory, 'https://www.imdb.com/name/nm0348181/bio/', [{
    status: 'ok',
    action: 'getAllText',
    extractedText: 'James Gunn was born in St. Louis, Missouri.'
  }]);
  assert.equal(agent.nextGoalSubgoal(memory), null);
});

test('extraction subgoal stays pending until extracted content is explicitly verified', () => {
  const agent = loadAgentComparisonFns();
  const memory = agent.buildGoalMemory('Go to https://docs.python.org/3/tutorial/datastructures.html, then extract the section explaining lists');

  assert.equal(agent.nextGoalSubgoal(memory).kind, 'navigate');
  agent.advanceGoalMemory(memory, 'https://docs.python.org/3/tutorial/datastructures.html', []);
  assert.equal(agent.nextGoalSubgoal(memory).kind, 'extract');
  agent.advanceGoalMemory(memory, 'https://docs.python.org/3/tutorial/datastructures.html', [{
    status: 'ok',
    action: 'getAllText',
    extractedText: 'The page loaded, but the requested section is not present.'
  }]);
  assert.equal(agent.nextGoalSubgoal(memory).kind, 'extract');
  agent.advanceGoalMemory(memory, 'https://docs.python.org/3/tutorial/datastructures.html', [], true);
  assert.equal(agent.nextGoalSubgoal(memory), null);
});

test('Strider route hints stay separate from the user goal and cannot create navigation subgoals', () => {
  const agent = loadAgentComparisonFns();
  const goal = 'Check the newest Node.js version and how to install it';
  const recon = '[Strider recon] Domain: codepen.io\nTop routes:\nhttps://codepen.io/trending';
  const taskContext = agent.splitBrowserTaskContext(goal, recon);

  assert.equal(taskContext.goal, goal);
  assert.match(taskContext.striderRecon, /codepen\.io\/trending/);
  const memory = agent.buildGoalMemory(taskContext.goal);
  assert.equal(memory.targetSite, '');
  assert.ok(!memory.subgoals.some(item => item.kind === 'navigate'));
});

test('Strider does not attach a previous-domain report to a task without a destination', () => {
  const agent = loadAgentComparisonFns();

  assert.equal(agent.buildStriderReconContext('Check the newest Node.js version and how to install it'), '');
  assert.equal(agent.buildStriderReconContext('Open https://nodejs.org/ and check the current version'), '');
});

test('supervisor chat notice summarizes planner, instinct, vision, heuristic, and research context', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const start = source.indexOf('async function generateSupervisorChatNotice');
  assert.notEqual(start, -1);
  const end = source.indexOf('\nasync function ', start + 1);
  const helperSource = source.slice(start, end);
  let promptMessages = null;
  const sandbox = {
    DEFAULT_MODELS: { reasoner: 'mock-reasoner' },
    callCFAI: async (_model, messages) => {
      promptMessages = messages;
      return 'The supervisor is cautious, but the task is continuing with the planner\'s next step.';
    }
  };
  vm.runInNewContext(helperSource, sandbox);

  const notice = await sandbox.generateSupervisorChatNotice({
    source: 'ai:mock-supervisor',
    supervisorReasons: ['Destination does not match the active subtask'],
    goal: 'Find the current Node.js version',
    currentSubtask: 'Read official download page',
    currentUrl: 'https://nodejs.org/en',
    plan: { confidence: 85, reasoning: 'Read current release', actions: [{ action: 'getAllText' }] },
    instinct: { evidenceStrength: 'high', relevantAnchors: [{ text: 'Download Node.js' }], evidenceGaps: [] },
    vision: { state: 'ready', summary: 'Official download page visible' },
    heuristicCandidate: { reasoning: 'Extract visible page text', actions: [{ action: 'getAllText' }] },
    research: { targetDomain: 'nodejs.org', hints: ['Official download page'] },
    recentActions: ['Step 1: goto:ok']
  }, {});

  assert.match(notice, /task is continuing/i);
  const promptText = promptMessages.map(message => message.content).join('\n');
  for (const evidence of ['Planner', 'Instinct', 'vision', 'heuristicCandidate', 'nodejs.org', 'Step 1']) {
    assert.ok(promptText.toLowerCase().includes(evidence.toLowerCase()), `missing ${evidence} from notice prompt`);
  }

  sandbox.callCFAI = async () => { throw new Error('model unavailable'); };
  const fallbackNotice = await sandbox.generateSupervisorChatNotice({
    supervisorReasons: ['low confidence'],
    plan: { actions: [{ action: 'goto' }] },
    vision: { state: 'uncertain' }
  }, {});
  assert.match(fallbackNotice, /continue/i);
  assert.match(fallbackNotice, /Vision is uncertain/i);
});

test('planner vision context exposes freshness, focus, blocker, and evidence', () => {
  const agent = loadAgentComparisonFns();
  const context = agent.buildPlannerVisionContext({
    active: true,
    lastFrameAt: 9500,
    latestUrl: 'https://archive.org/',
    summary: 'Archive search page is visible',
    signal: {
      state: 'ready',
      next_focus: 'search input field',
      blocker: 'none',
      evidence: 'The page is ready to interact.'
    }
  }, 10000);

  assert.equal(context.fresh, true);
  assert.equal(context.nextFocus, 'search input field');
  assert.equal(context.blocker, 'none');
  assert.match(context.evidence, /ready to interact/);
  assert.equal(context.latestUrl, 'https://archive.org/');
});

test('extraction verifier requires a supporting quote present in captured text', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  const start = source.indexOf('async function verifyExtractedTextForGoal');
  assert.notEqual(start, -1);
  const end = source.indexOf('\nfunction ', start + 1);
  const sandbox = {
    preserveEvidenceText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    compactPromptValue: value => String(value || '').trim(),
    safeParseJSON: value => JSON.parse(value),
    callCFAI: async () => JSON.stringify({
      covered: true,
      reason: 'The lists section is present.',
      supportingQuote: '5.1. More on Lists',
      retryHint: ''
    })
  };
  vm.runInNewContext(source.slice(start, end), sandbox);

  const valid = await sandbox.verifyExtractedTextForGoal(
    'Extract the section explaining lists',
    '5.1. More on Lists. Lists are mutable sequences.'
  );
  assert.equal(valid.accepted, true);

  sandbox.callCFAI = async () => JSON.stringify({
    covered: true,
    reason: 'It should be there.',
    supportingQuote: 'The lists section explains lists.',
    retryHint: 'Read the section heading.'
  });
  const unsupported = await sandbox.verifyExtractedTextForGoal(
    'Extract the section explaining lists',
    'This capture only contains the page header.'
  );
  assert.equal(unsupported.accepted, false);
  assert.equal(unsupported.supportingQuote, '');
});
