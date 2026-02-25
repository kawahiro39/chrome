const sourceSelect = document.getElementById('source-tab');
const destSelect = document.getElementById('dest-tab');
const projectSelect = document.getElementById('project-select');
const stateLine = document.getElementById('state-line');
const pairCount = document.getElementById('pair-count');
const pairList = document.getElementById('pair-list');
const runLog = document.getElementById('run-log');
const diagnosticOutput = document.getElementById('diagnostic-output');

const refreshTabsBtn = document.getElementById('refresh-tabs');
const startPairingBtn = document.getElementById('start-pairing');
const resumePairingBtn = document.getElementById('resume-pairing');
const stopPairingBtn = document.getElementById('stop-pairing');
const saveProjectBtn = document.getElementById('save-project');
const runProjectBtn = document.getElementById('run-project');
const diagnoseBtn = document.getElementById('diagnose');
const projectNameInput = document.getElementById('project-name');

let pollTimer;

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from background.'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error || 'Unknown error'));
        return;
      }
      resolve(response);
    });
  });
}

function tabLabel(tab) {
  return `${tab.id}: ${tab.title || '(no title)'} [${tab.url || ''}]`;
}

function setSelectOptions(select, items, placeholder) {
  select.innerHTML = '';
  if (!items.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
    return;
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = tabLabel(item);
    select.appendChild(opt);
  }
}

function projectStats(project) {
  const steps = project.steps || [];
  const pairTotal = steps.filter((step) => step.type === 'paste').length;
  return { stepsTotal: steps.length, pairTotal };
}

function renderSession(session) {
  const steps = session.steps || [];
  const pairTotal = typeof session.pairCount === 'number'
    ? session.pairCount
    : steps.filter((step) => step.type === 'paste').length;

  stateLine.textContent = `状態: ${session.statusText}`;
  pairCount.textContent = `現在の手順数: ${steps.length}（ペア数: ${pairTotal}）`;
  pairList.innerHTML = '';

  for (const [index, step] of steps.entries()) {
    const li = document.createElement('li');
    li.textContent = `手順${index + 1} [${step.type}/${step.tabRole}] ${step.selector}`;
    pairList.appendChild(li);
  }
}

function renderProjects(projects) {
  projectSelect.innerHTML = '';
  if (!projects.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '保存済みプロジェクトなし';
    projectSelect.appendChild(opt);
    return;
  }
  for (const project of projects) {
    const { stepsTotal, pairTotal } = projectStats(project);
    const opt = document.createElement('option');
    opt.value = project.projectId;
    opt.textContent = `${project.projectName} (手順${stepsTotal} / ペア${pairTotal})`;
    projectSelect.appendChild(opt);
  }
}

function renderRunLog(entries) {
  runLog.innerHTML = '';
  for (const line of entries) {
    const li = document.createElement('li');
    li.textContent = line;
    runLog.appendChild(li);
  }
}

async function refreshTabs() {
  const tabsResponse = await sendMessage('GET_TABS');
  setSelectOptions(sourceSelect, tabsResponse.tabs, 'タブが見つかりません');
  setSelectOptions(destSelect, tabsResponse.tabs, 'タブが見つかりません');
}

async function refreshProjects() {
  const projectsResponse = await sendMessage('LIST_PROJECTS');
  renderProjects(projectsResponse.projects);
}

async function refreshSession() {
  const sessionResponse = await sendMessage('GET_SESSION');
  renderSession(sessionResponse.session);
}

async function initialize() {
  const currentTab = await chrome.tabs.getCurrent();
  await sendMessage('APP_INIT', { uiTabId: currentTab.id });
  await refreshTabs();
  await refreshProjects();
  await refreshSession();

  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await refreshSession();
    } catch (error) {
      stateLine.textContent = `状態更新失敗: ${error.message}`;
    }
  }, 1000);
}

refreshTabsBtn.addEventListener('click', async () => {
  await refreshTabs();
});

startPairingBtn.addEventListener('click', async () => {
  await sendMessage('START_PAIRING', {
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  await refreshSession();
});

resumePairingBtn.addEventListener('click', async () => {
  await sendMessage('RESUME_PAIRING');
  await refreshSession();
});

stopPairingBtn.addEventListener('click', async () => {
  await sendMessage('STOP_PAIRING');
  await refreshSession();
});

saveProjectBtn.addEventListener('click', async () => {
  await sendMessage('SAVE_PROJECT', {
    projectName: projectNameInput.value.trim()
  });
  projectNameInput.value = '';
  await refreshProjects();
  await refreshSession();
});

runProjectBtn.addEventListener('click', async () => {
  const result = await sendMessage('RUN_PROJECT', {
    projectId: projectSelect.value,
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  renderRunLog(result.logs);
});

diagnoseBtn.addEventListener('click', async () => {
  const result = await sendMessage('RUN_DIAGNOSTIC', {
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  diagnosticOutput.textContent = JSON.stringify(result.diagnostic, null, 2);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'RUN_LOG_UPDATE') {
    renderRunLog(message.logs);
  }
});

initialize().catch((error) => {
  stateLine.textContent = `初期化失敗: ${error.message}`;
});
