const STORAGE_KEY = 'projects';

const state = {
  uiTabId: null,
  sourceTabId: null,
  destTabId: null,
  sourceUrl: '',
  destUrl: '',
  status: 'idle',
  pendingCopy: null,
  steps: [],
  runLogs: [],
  editingContext: null
};

function responseOk(sendResponse, payload = {}) {
  sendResponse({ ok: true, ...payload });
}

function responseError(sendResponse, error) {
  sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function statusText() {
  switch (state.status) {
    case 'copy_waiting':
      return 'コピー待ち（→1回:クリック手順 / →2回:ドロップダウン選択手順）';
    case 'paste_waiting':
      return 'ペースト待ち';
    case 'click_waiting_dest':
      return 'クリック待ち（ペースト先タブ / →でもう一度でドロップダウン選択）';
    case 'select_waiting_dest':
      return 'ドロップダウン選択待ち（ペースト先タブ）';
    case 'editing_copy':
      return '修正中（コピー元を選択してください）';
    case 'editing_paste':
      return '修正中（ペースト先inputを選択してください）';
    case 'editing_click':
      return '修正中（クリック先を選択してください）';
    case 'editing_select':
      return '修正中（ドロップダウンを選択してください）';
    case 'stopped':
      return '停止中';
    default:
      return '停止中';
  }
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.includes('chrome.google.com/webstore') ||
    /\.pdf([?#].*)?$/i.test(url)
  );
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'no_response' });
    });
  });
}

async function ensureInjected(tabId) {
  const ping = await sendToTab(tabId, { type: 'PING' });
  if (ping.ok) {
    return { injected: true, details: 'already_injected' };
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['contentScript.js']
  });
  const retry = await sendToTab(tabId, { type: 'PING' });
  if (!retry.ok) {
    throw new Error(`content script接続失敗: ${retry.error || 'unknown'}`);
  }
  return { injected: true, details: 'injected_now' };
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true });
}

async function stopSelectionOnTabs() {
  const tabIds = [state.sourceTabId, state.destTabId].filter(Boolean);
  for (const tabId of tabIds) {
    await sendToTab(tabId, { type: 'STOP_SELECTION' });
  }
}

function resetSession(keepTabs = true) {
  state.status = 'idle';
  state.pendingCopy = null;
  state.steps = [];
  state.editingContext = null;
  if (!keepTabs) {
    state.sourceTabId = null;
    state.destTabId = null;
    state.sourceUrl = '';
    state.destUrl = '';
  }
}

function toStepsFromMappings(mappings = []) {
  const steps = [];
  for (const mapping of mappings) {
    steps.push({
      stepId: crypto.randomUUID(),
      type: 'copy',
      tabRole: 'source',
      selector: mapping.sourceSelector,
      label: `${mapping.label || '項目'}-copy`
    });
    steps.push({
      stepId: crypto.randomUUID(),
      type: 'paste',
      tabRole: 'dest',
      selector: mapping.destSelector,
      label: `${mapping.label || '項目'}-paste`
    });
  }
  return steps;
}

function buildMappingsFromSteps(steps = []) {
  const mappings = [];
  let pendingSource = null;

  for (const step of steps) {
    if (step.type === 'copy' && step.tabRole === 'source') {
      pendingSource = step.selector;
      continue;
    }
    if (step.type === 'paste' && step.tabRole === 'dest' && pendingSource) {
      mappings.push({
        mappingId: crypto.randomUUID(),
        label: `項目${mappings.length + 1}`,
        sourceSelector: pendingSource,
        destSelector: step.selector
      });
      pendingSource = null;
    }
  }

  return mappings;
}

function projectSteps(project) {
  if (Array.isArray(project.steps) && project.steps.length) {
    return project.steps;
  }
  return toStepsFromMappings(project.mappings || []);
}

function pairCountFromSteps(steps = []) {
  return steps.filter((step) => step.type === 'paste').length;
}


function normalizeProject(project) {
  const steps = projectSteps(project);
  return {
    ...project,
    steps,
    mappings: project.mappings || buildMappingsFromSteps(steps)
  };
}


async function loadProjects() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function saveProjects(projects) {
  await chrome.storage.local.set({ [STORAGE_KEY]: projects });
}

async function waitTabComplete(tabId, timeoutMs = 20000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} load timeout`));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runProject(project, sourceTabId, destTabId) {
  if (!sourceTabId || !destTabId) {
    throw new Error('実行先のコピー元/ペースト先タブを選択してください。');
  }
  if (sourceTabId === destTabId) {
    throw new Error('実行先のコピー元/ペースト先は別タブを選択してください。');
  }

  const sourceTab = await chrome.tabs.get(sourceTabId);
  const destTab = await chrome.tabs.get(destTabId);

  if (isRestrictedUrl(sourceTab.url) || isRestrictedUrl(destTab.url)) {
    throw new Error('制限ページでは実行できません。http/httpsページを選択してください。');
  }

  await waitTabComplete(sourceTab.id);
  await waitTabComplete(destTab.id);

  await ensureInjected(sourceTab.id);
  await ensureInjected(destTab.id);

  const steps = projectSteps(project);
  const logs = [
    `ℹ️ 実行対象(コピー元): ${sourceTab.title || ''} [${sourceTab.url || ''}]`,
    `ℹ️ 実行対象(ペースト先): ${destTab.title || ''} [${destTab.url || ''}]`
  ];

  if (project.sourceUrl && sourceTab.url && project.sourceUrl !== sourceTab.url) {
    logs.push('⚠️ 保存時のコピー元URLと現在タブURLが異なります。現在タブで実行を継続します。');
  }
  if (project.destUrl && destTab.url && project.destUrl !== destTab.url) {
    logs.push('⚠️ 保存時のペースト先URLと現在タブURLが異なります。現在タブで実行を継続します。');
  }

  let lastValue = '';
  let hasValue = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepLabel = step.label || `手順${index + 1}`;
    const targetTabId = step.tabRole === 'source' ? sourceTab.id : destTab.id;

    try {
      if (step.type === 'copy') {
        const [copyResult] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          args: [step.selector],
          func: (selector) => {
            const node = document.querySelector(selector);
            if (!node) {
              return { ok: false, error: `source not found: ${selector}` };
            }
            const value = 'value' in node ? node.value : node.textContent || '';
            return { ok: true, value };
          }
        });

        if (!copyResult.result.ok) {
          throw new Error(copyResult.result.error);
        }

        lastValue = copyResult.result.value;
        hasValue = true;
        logs.push(`✅ ${stepLabel}: コピー成功`);
        continue;
      }

      if (step.type === 'click') {
        const [clickResult] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: 'MAIN',
          args: [step.selector],
          func: (selector) => {
            const node = document.querySelector(selector);
            if (!node) {
              return { ok: false, error: `click target not found: ${selector}` };
            }

            const view = node.ownerDocument?.defaultView || window;
            node.scrollIntoView({ block: 'center', inline: 'center' });

            if (typeof node.focus === 'function') {
              node.focus({ preventScroll: true });
            }

            const eventInit = { bubbles: true, cancelable: true, composed: true, view };
            const mouseEventInit = { ...eventInit, button: 0, buttons: 1, detail: 1 };
            const pointerCtor = view.PointerEvent || view.MouseEvent;

            node.dispatchEvent(new pointerCtor('pointerdown', mouseEventInit));
            node.dispatchEvent(new view.MouseEvent('mousedown', mouseEventInit));
            node.dispatchEvent(new pointerCtor('pointerup', mouseEventInit));
            node.dispatchEvent(new view.MouseEvent('mouseup', mouseEventInit));
            node.dispatchEvent(new view.MouseEvent('click', mouseEventInit));

            if (typeof node.click === 'function') {
              node.click();
            }

            const href = typeof node.getAttribute === 'function' ? node.getAttribute('href') || '' : '';
            if (/^javascript:/i.test(href)) {
              const script = href.replace(/^javascript:/i, '').trim().replace(/;$/, '');
              const fnMatch = script.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\((.*)\)$/);

              try {
                if (fnMatch) {
                  const fnPath = fnMatch[1].split('.');
                  const argsRaw = fnMatch[2].trim();
                  const args = argsRaw
                    ? Function(`return [${argsRaw}]`)()
                    : [];
                  let ctx = view;
                  let fn = view;
                  for (const key of fnPath) {
                    fn = fn[key];
                    if (fn == null) {
                      throw new Error(`function not found: ${fnPath.join('.')}`);
                    }
                    if (key !== fnPath[fnPath.length - 1]) {
                      ctx = fn;
                    }
                  }
                  if (typeof fn !== 'function') {
                    throw new Error(`target is not function: ${fnPath.join('.')}`);
                  }
                  fn.apply(ctx, args);
                } else {
                  const jump = view.document.createElement('a');
                  jump.href = href;
                  jump.click();
                }
              } catch (error) {
                return { ok: false, error: `javascript href failed: ${error.message}` };
              }
            }

            return { ok: true };
          }
        });

        if (!clickResult.result.ok) {
          throw new Error(clickResult.result.error);
        }

        logs.push(`✅ ${stepLabel}: クリック成功`);
        continue;
      }

      if (step.type === 'select') {
        const [selectResult] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          args: [step.selector, step.selectedValue, step.selectedText],
          func: (selector, selectedValue, selectedText) => {
            const node = document.querySelector(selector);
            if (!node) {
              return { ok: false, error: `select target not found: ${selector}` };
            }
            const tag = node.tagName.toLowerCase();
            if (tag !== 'select') {
              return { ok: false, error: `target is not select: ${selector}` };
            }

            const options = Array.from(node.options || []);
            let matched = options.find((opt) => opt.value === selectedValue);
            if (!matched && selectedText) {
              matched = options.find((opt) => (opt.textContent || '').trim() === selectedText.trim());
            }
            if (!matched) {
              return { ok: false, error: `option not found: ${selectedValue || selectedText || '(empty)'}` };
            }

            node.value = matched.value;
            matched.selected = true;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, selectedValue: matched.value, selectedText: (matched.textContent || '').trim() };
          }
        });

        if (!selectResult.result.ok) {
          throw new Error(selectResult.result.error);
        }

        logs.push(`✅ ${stepLabel}: ドロップダウン選択成功 (${selectResult.result.selectedText || selectResult.result.selectedValue})`);
        continue;
      }

      if (step.type === 'paste') {
        if (!hasValue) {
          throw new Error('paste前にcopy手順がありません。');
        }

        const [pasteResult] = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          args: [step.selector, lastValue],
          func: (selector, value) => {
            const node = document.querySelector(selector);
            if (!node) {
              return { ok: false, error: `dest not found: ${selector}` };
            }
            const tag = node.tagName.toLowerCase();
            if (tag !== 'input') {
              return { ok: false, error: `dest is not input: ${selector}` };
            }
            node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
        });

        if (!pasteResult.result.ok) {
          throw new Error(pasteResult.result.error);
        }

        logs.push(`✅ ${stepLabel}: ペースト成功`);
        continue;
      }

      logs.push(`⚠️ ${stepLabel}: 未対応手順 type=${step.type}`);
    } catch (error) {
      logs.push(`❌ ${stepLabel}: ${error.message}`);
    }
  }

  await focusTab(destTab.id);
  return logs;
}

async function startPairing(sourceTabId, destTabId) {
  if (!sourceTabId || !destTabId) {
    throw new Error('コピー元とペースト先タブを選択してください。');
  }
  if (sourceTabId === destTabId) {
    throw new Error('コピー元とペースト先は別タブを選択してください。');
  }

  const sourceTab = await chrome.tabs.get(sourceTabId);
  const destTab = await chrome.tabs.get(destTabId);

  if (isRestrictedUrl(sourceTab.url) || isRestrictedUrl(destTab.url)) {
    throw new Error('制限ページは選択できません。http/httpsページを選んでください。');
  }

  await ensureInjected(sourceTabId);
  await ensureInjected(destTabId);

  state.sourceTabId = sourceTabId;
  state.destTabId = destTabId;
  state.sourceUrl = sourceTab.url;
  state.destUrl = destTab.url;
  state.pendingCopy = null;
  state.steps = [];
  state.status = 'copy_waiting';

  await sendToTab(sourceTabId, { type: 'START_SELECTION', mode: 'copy' });
  await sendToTab(destTabId, { type: 'STOP_SELECTION' });
  await focusTab(sourceTabId);
}

async function resumePairing() {
  if (!state.sourceTabId || !state.destTabId) {
    throw new Error('再開できるセッションがありません。');
  }
  state.pendingCopy = null;
  state.status = 'copy_waiting';
  await ensureInjected(state.sourceTabId);
  await ensureInjected(state.destTabId);
  await sendToTab(state.sourceTabId, { type: 'START_SELECTION', mode: 'copy' });
  await sendToTab(state.destTabId, { type: 'STOP_SELECTION' });
  await focusTab(state.sourceTabId);
}

async function stopPairing(focusUi = false) {
  state.status = 'stopped';
  state.pendingCopy = null;
  state.editingContext = null;
  await stopSelectionOnTabs();
  const tabIds = [state.sourceTabId, state.destTabId].filter(Boolean);
  for (const tabId of tabIds) {
    await sendToTab(tabId, { type: 'CLEAR_STEP_HIGHLIGHTS' });
  }
  if (focusUi && state.uiTabId) {
    await focusTab(state.uiTabId);
  }
}


function stepColor(step, activeStepId) {
  if (step.stepId === activeStepId) {
    return '#ef4444';
  }
  return step.tabRole === 'source' ? '#2563eb' : '#16a34a';
}

async function applyProjectHighlights(project, activeStepId) {
  const sourceHighlights = [];
  const destHighlights = [];
  for (const step of project.steps || []) {
    const item = {
      selector: step.selector,
      color: stepColor(step, activeStepId),
      label: `${step.type}/${step.tabRole}${step.stepId === activeStepId ? ' (編集中)' : ''}`
    };
    if (step.tabRole === 'source') {
      sourceHighlights.push(item);
    } else if (step.tabRole === 'dest') {
      destHighlights.push(item);
    }
  }

  if (state.sourceTabId) {
    await sendToTab(state.sourceTabId, { type: 'APPLY_STEP_HIGHLIGHTS', highlights: sourceHighlights });
  }
  if (state.destTabId) {
    await sendToTab(state.destTabId, { type: 'APPLY_STEP_HIGHLIGHTS', highlights: destHighlights });
  }
}

async function prepareProjectStepEdit(projectId, stepId, sourceTabId, destTabId) {
  if (!projectId || !stepId) {
    throw new Error('projectIdとstepIdが必要です。');
  }
  if (!sourceTabId || !destTabId) {
    throw new Error('コピー元とペースト先タブを選択してください。');
  }
  if (sourceTabId === destTabId) {
    throw new Error('コピー元とペースト先は別タブを選択してください。');
  }

  const sourceTab = await chrome.tabs.get(sourceTabId);
  const destTab = await chrome.tabs.get(destTabId);
  if (isRestrictedUrl(sourceTab.url) || isRestrictedUrl(destTab.url)) {
    throw new Error('制限ページは選択できません。http/httpsページを選んでください。');
  }

  const projects = await loadProjects();
  const project = projects.find((item) => item.projectId === projectId);
  if (!project) {
    throw new Error('プロジェクトが見つかりません。');
  }
  const normalized = normalizeProject(project);
  const step = normalized.steps.find((item) => item.stepId === stepId);
  if (!step) {
    throw new Error('手順が見つかりません。');
  }

  await ensureInjected(sourceTabId);
  await ensureInjected(destTabId);

  state.sourceTabId = sourceTabId;
  state.destTabId = destTabId;
  state.sourceUrl = sourceTab.url;
  state.destUrl = destTab.url;
  state.pendingCopy = null;
  state.steps = [];

  const targetTabId = step.tabRole === 'source' ? sourceTabId : destTabId;
  const mode = step.type === 'paste' ? 'paste' : step.type === 'select' ? 'select' : step.type === 'click' ? 'click' : 'copy';

  state.editingContext = { projectId, stepId, targetTabId, mode };
  state.status = `editing_${step.type}`;

  await stopSelectionOnTabs();
  await applyProjectHighlights(normalized, stepId);
  await sendToTab(targetTabId, { type: 'START_SELECTION', mode });
  await focusTab(targetTabId);
  return { step };
}

async function commitProjectStepEdit(message, senderTabId) {
  const ctx = state.editingContext;
  if (!ctx) return false;
  if (senderTabId !== ctx.targetTabId) {
    throw new Error('編集中の対象タブではありません。');
  }

  const projects = await loadProjects();
  const projectIndex = projects.findIndex((item) => item.projectId === ctx.projectId);
  if (projectIndex < 0) {
    throw new Error('プロジェクトが見つかりません。');
  }
  const project = normalizeProject(projects[projectIndex]);
  const stepIndex = project.steps.findIndex((item) => item.stepId === ctx.stepId);
  if (stepIndex < 0) {
    throw new Error('手順が見つかりません。');
  }

  const step = { ...project.steps[stepIndex] };
  if (step.type === 'paste' && message.tagName !== 'input') {
    throw new Error('ペースト手順はinput要素のみ選択できます。');
  }
  if (step.type === 'select' && message.tagName !== 'select') {
    throw new Error('ドロップダウン手順はselect要素を選択してください。');
  }

  step.selector = message.selector;
  if (step.type === 'copy') {
    step.sampleText = message.textSample || '';
  }
  if (step.type === 'select') {
    step.selectedValue = message.selectedValue || '';
    step.selectedText = message.selectedText || '';
  }

  project.steps[stepIndex] = step;
  project.mappings = buildMappingsFromSteps(project.steps);
  projects[projectIndex] = project;
  await saveProjects(projects);

  state.editingContext = null;
  state.status = 'stopped';
  await stopSelectionOnTabs();
  if (state.sourceTabId) await sendToTab(state.sourceTabId, { type: 'CLEAR_STEP_HIGHLIGHTS' });
  if (state.destTabId) await sendToTab(state.destTabId, { type: 'CLEAR_STEP_HIGHLIGHTS' });
  if (state.uiTabId) await focusTab(state.uiTabId);
  chrome.runtime.sendMessage({ type: 'PROJECTS_UPDATED' });
  return true;
}

async function startClickStepFromSource(requestTabId) {
  if (state.status !== 'copy_waiting') {
    throw new Error('クリック手順追加はコピー待ち状態でのみ実行できます。');
  }
  if (requestTabId !== state.sourceTabId) {
    throw new Error('クリック手順追加はコピー元タブで→キーを押してください。');
  }

  await sendToTab(state.sourceTabId, { type: 'STOP_SELECTION' });
  await ensureInjected(state.destTabId);
  await sendToTab(state.destTabId, { type: 'START_SELECTION', mode: 'click' });
  state.status = 'click_waiting_dest';
  await focusTab(state.destTabId);
}

async function startSelectStepFromDest(requestTabId) {
  if (state.status !== 'click_waiting_dest') {
    throw new Error('ドロップダウン手順追加はクリック待ち状態でのみ実行できます。');
  }
  if (requestTabId !== state.destTabId) {
    throw new Error('ドロップダウン手順追加はペースト先タブで→キーを押してください。');
  }

  await ensureInjected(state.destTabId);
  await sendToTab(state.destTabId, { type: 'START_SELECTION', mode: 'select' });
  state.status = 'select_waiting_dest';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'APP_INIT': {
        state.uiTabId = message.uiTabId;
        responseOk(sendResponse, { session: { statusText: statusText(), steps: state.steps } });
        break;
      }
      case 'GET_TABS': {
        const tabs = await chrome.tabs.query({});
        const filtered = tabs.filter((tab) => tab.id && tab.url && !tab.url.startsWith('chrome-extension://'));
        responseOk(sendResponse, { tabs: filtered.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })) });
        break;
      }
      case 'START_PAIRING': {
        await startPairing(message.sourceTabId, message.destTabId);
        responseOk(sendResponse, {});
        break;
      }
      case 'RESUME_PAIRING': {
        await resumePairing();
        responseOk(sendResponse, {});
        break;
      }
      case 'STOP_PAIRING': {
        await stopPairing(true);
        responseOk(sendResponse, {});
        break;
      }
      case 'GET_SESSION': {
        responseOk(sendResponse, {
          session: {
            status: state.status,
            statusText: statusText(),
            sourceTabId: state.sourceTabId,
            destTabId: state.destTabId,
            sourceUrl: state.sourceUrl,
            destUrl: state.destUrl,
            steps: state.steps,
            pairCount: pairCountFromSteps(state.steps)
          }
        });
        break;
      }
      case 'SAVE_PROJECT': {
        const name = (message.projectName || '').trim();
        if (!name) {
          throw new Error('プロジェクト名を入力してください。');
        }
        if (!state.steps.length) {
          throw new Error('手順が0件のため保存できません。');
        }
        if (!pairCountFromSteps(state.steps)) {
          throw new Error('ペア(コピー→ペースト)が0件のため保存できません。');
        }
        if (state.pendingCopy) {
          throw new Error('1対1が未完了です。ペースト先を選択してください。');
        }
        const projects = await loadProjects();
        projects.push({
          projectId: crypto.randomUUID(),
          projectName: name,
          sourceUrl: state.sourceUrl,
          destUrl: state.destUrl,
          steps: state.steps,
          mappings: buildMappingsFromSteps(state.steps)
        });
        await saveProjects(projects);
        await stopPairing(false);
        resetSession(true);
        responseOk(sendResponse, {});
        break;
      }
      case 'LIST_PROJECTS': {
        const projects = await loadProjects();
        responseOk(sendResponse, {
          projects: projects.map((project) => normalizeProject(project))
        });
        break;
      }
      case 'UPDATE_PROJECT': {
        if (!message.projectId) {
          throw new Error('projectIdが必要です。');
        }
        const projects = await loadProjects();
        const index = projects.findIndex((item) => item.projectId === message.projectId);
        if (index < 0) {
          throw new Error('プロジェクトが見つかりません。');
        }
        const project = normalizeProject(projects[index]);
        const patch = message.patch || {};
        if (typeof patch.projectName === 'string') {
          const name = patch.projectName.trim();
          if (!name) {
            throw new Error('プロジェクト名を空にできません。');
          }
          project.projectName = name;
        }
        projects[index] = project;
        await saveProjects(projects);
        responseOk(sendResponse, { project });
        break;
      }
      case 'PREPARE_PROJECT_STEP_EDIT': {
        const result = await prepareProjectStepEdit(
          message.projectId,
          message.stepId,
          message.sourceTabId,
          message.destTabId
        );
        responseOk(sendResponse, result);
        break;
      }
      case 'UPDATE_PROJECT_STEP': {
        const { projectId, stepId, patch = {} } = message;
        if (!projectId || !stepId) {
          throw new Error('projectIdとstepIdが必要です。');
        }

        const projects = await loadProjects();
        const projectIndex = projects.findIndex((item) => item.projectId === projectId);
        if (projectIndex < 0) {
          throw new Error('プロジェクトが見つかりません。');
        }

        const project = normalizeProject(projects[projectIndex]);
        const stepIndex = project.steps.findIndex((item) => item.stepId === stepId);
        if (stepIndex < 0) {
          throw new Error('手順が見つかりません。');
        }

        const step = { ...project.steps[stepIndex] };
        if (typeof patch.selector === 'string' && patch.selector.trim()) {
          step.selector = patch.selector.trim();
        }
        if (typeof patch.label === 'string') {
          step.label = patch.label;
        }
        if (step.type === 'select') {
          if (typeof patch.selectedValue === 'string') {
            step.selectedValue = patch.selectedValue;
          }
          if (typeof patch.selectedText === 'string') {
            step.selectedText = patch.selectedText;
          }
        }

        project.steps[stepIndex] = step;
        project.mappings = buildMappingsFromSteps(project.steps);
        projects[projectIndex] = project;
        await saveProjects(projects);

        responseOk(sendResponse, { project });
        break;
      }
      case 'DELETE_PROJECT_STEP': {
        const { projectId, stepId } = message;
        if (!projectId || !stepId) {
          throw new Error('projectIdとstepIdが必要です。');
        }

        const projects = await loadProjects();
        const projectIndex = projects.findIndex((item) => item.projectId === projectId);
        if (projectIndex < 0) {
          throw new Error('プロジェクトが見つかりません。');
        }

        const project = normalizeProject(projects[projectIndex]);
        const nextSteps = project.steps.filter((step) => step.stepId !== stepId);
        if (nextSteps.length === project.steps.length) {
          throw new Error('手順が見つかりません。');
        }

        project.steps = nextSteps;
        project.mappings = buildMappingsFromSteps(nextSteps);
        projects[projectIndex] = project;
        await saveProjects(projects);

        responseOk(sendResponse, { project });
        break;
      }

      case 'MOVE_PROJECT_STEP': {
        const { projectId, stepId, direction } = message;
        if (!projectId || !stepId) {
          throw new Error('projectIdとstepIdが必要です。');
        }
        if (direction !== 'up' && direction !== 'down') {
          throw new Error('directionはup/downを指定してください。');
        }

        const projects = await loadProjects();
        const projectIndex = projects.findIndex((item) => item.projectId === projectId);
        if (projectIndex < 0) {
          throw new Error('プロジェクトが見つかりません。');
        }

        const project = normalizeProject(projects[projectIndex]);
        const index = project.steps.findIndex((step) => step.stepId === stepId);
        if (index < 0) {
          throw new Error('手順が見つかりません。');
        }

        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= project.steps.length) {
          responseOk(sendResponse, { project });
          break;
        }

        const nextSteps = [...project.steps];
        const temp = nextSteps[index];
        nextSteps[index] = nextSteps[targetIndex];
        nextSteps[targetIndex] = temp;

        project.steps = nextSteps;
        project.mappings = buildMappingsFromSteps(nextSteps);
        projects[projectIndex] = project;
        await saveProjects(projects);

        responseOk(sendResponse, { project });
        break;
      }
      case 'RUN_PROJECT': {
        if (!message.projectId) {
          throw new Error('プロジェクトを選択してください。');
        }
        const projects = await loadProjects();
        const project = projects.find((item) => item.projectId === message.projectId);
        if (!project) {
          throw new Error('プロジェクトが見つかりません。');
        }
        const logs = await runProject(project, message.sourceTabId, message.destTabId);
        state.runLogs = logs;
        responseOk(sendResponse, { logs });
        break;
      }
      case 'RUN_DIAGNOSTIC': {
        const tabIds = [message.sourceTabId, message.destTabId].filter(Boolean);
        const diagnostic = [];

        for (const tabId of tabIds) {
          const tab = await chrome.tabs.get(tabId);
          const item = {
            tabId,
            url: tab.url,
            restricted: isRestrictedUrl(tab.url),
            injected: false,
            note: ''
          };
          if (item.restricted) {
            item.note = '制限ページです。http/httpsページを選択してください。';
          } else {
            try {
              await ensureInjected(tabId);
              item.injected = true;
              item.note = tab.url.startsWith('file://')
                ? 'file:// は拡張機能設定で「ファイルのURLへのアクセスを許可」が必要です。'
                : 'OK';
            } catch (error) {
              item.injected = false;
              item.note = `注入失敗: ${error.message} / F5で再読込推奨`;
            }
          }
          diagnostic.push(item);
        }

        responseOk(sendResponse, { diagnostic });
        break;
      }
      case 'CLICK_MODE_REQUESTED': {
        if (!sender.tab?.id) {
          throw new Error('tab情報が取得できません。');
        }
        await startClickStepFromSource(sender.tab.id);
        responseOk(sendResponse, {});
        break;
      }
      case 'SELECT_MODE_REQUESTED': {
        if (!sender.tab?.id) {
          throw new Error('tab情報が取得できません。');
        }
        await startSelectStepFromDest(sender.tab.id);
        responseOk(sendResponse, {});
        break;
      }
      case 'ELEMENT_SELECTED': {
        if (!sender.tab?.id) {
          throw new Error('tab情報が取得できません。');
        }
        const tabId = sender.tab.id;

        if (state.editingContext) {
          const updated = await commitProjectStepEdit(message, tabId);
          if (updated) {
            responseOk(sendResponse, {});
            return;
          }
        }

        if (state.status === 'copy_waiting' && tabId === state.sourceTabId) {
          state.pendingCopy = {
            sourceSelector: message.selector,
            sourceSample: message.textSample || ''
          };
          state.status = 'paste_waiting';
          await sendToTab(state.sourceTabId, { type: 'STOP_SELECTION' });
          await sendToTab(state.destTabId, { type: 'START_SELECTION', mode: 'paste' });
          await focusTab(state.destTabId);
          responseOk(sendResponse, {});
          return;
        }

        if (state.status === 'paste_waiting' && tabId === state.destTabId) {
          if (message.tagName !== 'input') {
            throw new Error('ペースト先はinput要素のみ選択できます。');
          }
          const pairIndex = pairCountFromSteps(state.steps) + 1;
          state.steps.push({
            stepId: crypto.randomUUID(),
            type: 'copy',
            tabRole: 'source',
            selector: state.pendingCopy.sourceSelector,
            label: `項目${pairIndex}-copy`,
            sampleText: state.pendingCopy.sourceSample || ''
          });
          state.steps.push({
            stepId: crypto.randomUUID(),
            type: 'paste',
            tabRole: 'dest',
            selector: message.selector,
            label: `項目${pairIndex}-paste`
          });
          state.pendingCopy = null;
          state.status = 'copy_waiting';
          await sendToTab(state.destTabId, { type: 'STOP_SELECTION' });
          await sendToTab(state.sourceTabId, { type: 'START_SELECTION', mode: 'copy' });
          await focusTab(state.sourceTabId);
          responseOk(sendResponse, {});
          return;
        }

        if (state.status === 'click_waiting_dest' && tabId === state.destTabId) {
          state.steps.push({
            stepId: crypto.randomUUID(),
            type: 'click',
            tabRole: 'dest',
            selector: message.selector,
            label: `クリック${state.steps.filter((step) => step.type === 'click').length + 1}`
          });
          state.status = 'copy_waiting';
          await sendToTab(state.destTabId, { type: 'STOP_SELECTION' });
          await sendToTab(state.sourceTabId, { type: 'START_SELECTION', mode: 'copy' });
          await focusTab(state.sourceTabId);
          responseOk(sendResponse, {});
          return;
        }

        if (state.status === 'select_waiting_dest' && tabId === state.destTabId) {
          if (message.tagName !== 'select') {
            throw new Error('ドロップダウン選択手順はselect要素で選択してください。');
          }
          state.steps.push({
            stepId: crypto.randomUUID(),
            type: 'select',
            tabRole: 'dest',
            selector: message.selector,
            selectedValue: message.selectedValue,
            selectedText: message.selectedText,
            label: `選択${state.steps.filter((step) => step.type === 'select').length + 1}`
          });
          state.status = 'copy_waiting';
          await sendToTab(state.destTabId, { type: 'STOP_SELECTION' });
          await sendToTab(state.sourceTabId, { type: 'START_SELECTION', mode: 'copy' });
          await focusTab(state.sourceTabId);
          responseOk(sendResponse, {});
          return;
        }

        throw new Error('現在の状態ではこの選択を受け付けできません。');
      }
      case 'ESC_PRESSED': {
        await stopPairing(true);
        responseOk(sendResponse, {});
        break;
      }
      default:
        responseOk(sendResponse, {});
    }
  })().catch((error) => {
    responseError(sendResponse, error);
  });

  return true;
});
