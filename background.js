const STORAGE_KEY = 'projects';

const state = {
  uiTabId: null,
  sourceTabId: null,
  destTabId: null,
  sourceUrl: '',
  destUrl: '',
  status: 'idle',
  pendingCopy: null,
  mappings: [],
  runLogs: []
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
      return 'コピー待ち';
    case 'paste_waiting':
      return 'ペースト待ち';
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
  state.mappings = [];
  if (!keepTabs) {
    state.sourceTabId = null;
    state.destTabId = null;
    state.sourceUrl = '';
    state.destUrl = '';
  }
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

  for (const mapping of project.mappings) {
    let sourceValue = '';
    try {
      const [sourceResult] = await chrome.scripting.executeScript({
        target: { tabId: sourceTab.id },
        args: [mapping.sourceSelector],
        func: (selector) => {
          const node = document.querySelector(selector);
          if (!node) {
            return { ok: false, error: `source not found: ${selector}` };
          }
          const value = 'value' in node ? node.value : node.textContent || '';
          return { ok: true, value };
        }
      });
      if (!sourceResult.result.ok) {
        throw new Error(sourceResult.result.error);
      }
      sourceValue = sourceResult.result.value;

      const [destResult] = await chrome.scripting.executeScript({
        target: { tabId: destTab.id },
        args: [mapping.destSelector, sourceValue],
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

      if (!destResult.result.ok) {
        throw new Error(destResult.result.error);
      }
      logs.push(`✅ ${mapping.label}: 転記成功`);
    } catch (error) {
      logs.push(`❌ ${mapping.label}: ${error.message}`);
    }
  }

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
  state.mappings = [];
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
  await stopSelectionOnTabs();
  if (focusUi && state.uiTabId) {
    await focusTab(state.uiTabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'APP_INIT': {
        state.uiTabId = message.uiTabId;
        responseOk(sendResponse, { session: { statusText: statusText(), mappings: state.mappings } });
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
            mappings: state.mappings
          }
        });
        break;
      }
      case 'SAVE_PROJECT': {
        const name = (message.projectName || '').trim();
        if (!name) {
          throw new Error('プロジェクト名を入力してください。');
        }
        if (!state.mappings.length) {
          throw new Error('ペアが0件のため保存できません。');
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
          mappings: state.mappings
        });
        await saveProjects(projects);
        await stopPairing(false);
        resetSession(true);
        responseOk(sendResponse, {});
        break;
      }
      case 'LIST_PROJECTS': {
        const projects = await loadProjects();
        responseOk(sendResponse, { projects });
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
      case 'ELEMENT_SELECTED': {
        if (!sender.tab?.id) {
          throw new Error('tab情報が取得できません。');
        }
        const tabId = sender.tab.id;
        if (state.status === 'copy_waiting' && tabId === state.sourceTabId) {
          state.pendingCopy = {
            sourceSelector: message.selector
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
          state.mappings.push({
            mappingId: crypto.randomUUID(),
            label: `項目${state.mappings.length + 1}`,
            sourceSelector: state.pendingCopy.sourceSelector,
            destSelector: message.selector
          });
          state.pendingCopy = null;
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
