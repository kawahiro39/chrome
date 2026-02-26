const sourceSelect = document.getElementById('source-tab');
const destSelect = document.getElementById('dest-tab');
const projectSelect = document.getElementById('project-select');
const stateLine = document.getElementById('state-line');
const pairCount = document.getElementById('pair-count');
const pairList = document.getElementById('pair-list');
const projectStepList = document.getElementById('project-step-list');
const runLog = document.getElementById('run-log');
const diagnosticOutput = document.getElementById('diagnostic-output');
const toast = document.getElementById('toast');

const refreshTabsBtn = document.getElementById('refresh-tabs');
const startPairingBtn = document.getElementById('start-pairing');
const resumePairingBtn = document.getElementById('resume-pairing');
const stopPairingBtn = document.getElementById('stop-pairing');
const saveProjectBtn = document.getElementById('save-project');
const runProjectBtn = document.getElementById('run-project');
const diagnoseBtn = document.getElementById('diagnose');
const renameProjectBtn = document.getElementById('rename-project');
const projectNameInput = document.getElementById('project-name');

let pollTimer;
let toastTimer;
let projectsCache = [];

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

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

function selectedProject() {
  return projectsCache.find((project) => project.projectId === projectSelect.value) || null;
}

function stepSummary(step) {
  if (step.type === 'select') {
    return `${step.type}/${step.tabRole} ${step.selector} => ${step.selectedText || step.selectedValue || ''}`;
  }
  return `${step.type}/${step.tabRole} ${step.selector}`;
}

function renderStepEditor(project) {
  projectStepList.innerHTML = '';
  if (!project) {
    const li = document.createElement('li');
    li.textContent = '編集するプロジェクトを選択してください。';
    projectStepList.appendChild(li);
    return;
  }

  const steps = project.steps || [];
  if (!steps.length) {
    const li = document.createElement('li');
    li.textContent = '手順がありません。';
    projectStepList.appendChild(li);
    return;
  }

  for (const [index, step] of steps.entries()) {
    const li = document.createElement('li');
    li.dataset.stepId = step.stepId;

    const text = document.createElement('span');
    text.textContent = `手順${index + 1}: ${stepSummary(step)}`;
    li.appendChild(text);

    const editBtn = document.createElement('button');
    editBtn.textContent = '修正';
    editBtn.className = 'edit-btn';
    editBtn.dataset.stepId = step.stepId;
    li.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    deleteBtn.className = 'delete-btn';
    deleteBtn.dataset.stepId = step.stepId;
    li.appendChild(deleteBtn);

    projectStepList.appendChild(li);
  }
}

function renderSession(session) {
  const steps = session.steps || [];
  const pairTotal = typeof session.pairCount === 'number'
    ? session.pairCount
    : steps.filter((step) => step.type === 'paste').length;

  stateLine.textContent = `状態: ${session.statusText}`;
  pairCount.textContent = `手順: ${steps.length} / ペア: ${pairTotal}`;
  pairList.innerHTML = '';

  for (const [index, step] of steps.entries()) {
    const li = document.createElement('li');
    li.textContent = `手順${index + 1} [${step.type}/${step.tabRole}] ${step.selector}`;
    pairList.appendChild(li);
  }
}

function renderProjects(projects) {
  const current = projectSelect.value;
  projectsCache = projects;
  projectSelect.innerHTML = '';

  if (!projects.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '保存済みプロジェクトなし';
    projectSelect.appendChild(opt);
    renderStepEditor(null);
    return;
  }

  for (const project of projects) {
    const { stepsTotal, pairTotal } = projectStats(project);
    const opt = document.createElement('option');
    opt.value = project.projectId;
    opt.textContent = `${project.projectName} (手順${stepsTotal} / ペア${pairTotal})`;
    projectSelect.appendChild(opt);
  }

  if (current && projects.some((project) => project.projectId === current)) {
    projectSelect.value = current;
  }

  renderStepEditor(selectedProject());
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

async function safeAction(action, successMessage) {
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(`エラー: ${error.message}`);
  }
}

function buildEditPayload(step) {
  const selector = window.prompt('selectorを入力してください', step.selector || '');
  if (selector === null) return null;

  const payload = {
    selector: selector.trim() || step.selector,
    label: step.label || ''
  };

  if (step.type === 'select') {
    const value = window.prompt('selectedValueを入力してください', step.selectedValue || '');
    if (value === null) return null;
    const text = window.prompt('selectedTextを入力してください', step.selectedText || '');
    if (text === null) return null;
    payload.selectedValue = value;
    payload.selectedText = text;
  }

  return payload;
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

refreshTabsBtn.addEventListener('click', () => safeAction(async () => {
  await refreshTabs();
}, 'タブ一覧を更新しました'));

startPairingBtn.addEventListener('click', () => safeAction(async () => {
  await sendMessage('START_PAIRING', {
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  await refreshSession();
}, '選択モードを開始しました'));

resumePairingBtn.addEventListener('click', () => safeAction(async () => {
  await sendMessage('RESUME_PAIRING');
  await refreshSession();
}, '再開しました'));

stopPairingBtn.addEventListener('click', () => safeAction(async () => {
  await sendMessage('STOP_PAIRING');
  await refreshSession();
}, '停止しました'));

saveProjectBtn.addEventListener('click', () => safeAction(async () => {
  await sendMessage('SAVE_PROJECT', {
    projectName: projectNameInput.value.trim()
  });
  projectNameInput.value = '';
  await refreshProjects();
  await refreshSession();
}, 'プロジェクトを保存しました'));

runProjectBtn.addEventListener('click', () => safeAction(async () => {
  const result = await sendMessage('RUN_PROJECT', {
    projectId: projectSelect.value,
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  renderRunLog(result.logs);
}, '実行が完了しました'));

diagnoseBtn.addEventListener('click', () => safeAction(async () => {
  const result = await sendMessage('RUN_DIAGNOSTIC', {
    sourceTabId: Number(sourceSelect.value),
    destTabId: Number(destSelect.value)
  });
  diagnosticOutput.textContent = JSON.stringify(result.diagnostic, null, 2);
}, '診断結果を更新しました'));

renameProjectBtn.addEventListener('click', () => safeAction(async () => {
  const project = selectedProject();
  if (!project) {
    throw new Error('プロジェクトを選択してください。');
  }
  const name = window.prompt('新しいプロジェクト名', project.projectName || '');
  if (name === null) return;

  await sendMessage('UPDATE_PROJECT', {
    projectId: project.projectId,
    patch: { projectName: name.trim() || project.projectName }
  });
  await refreshProjects();
}, 'プロジェクト名を更新しました'));

projectStepList.addEventListener('click', (event) => {
  const button = event.target;
  if (!(button instanceof HTMLButtonElement)) return;

  const project = selectedProject();
  if (!project) {
    showToast('プロジェクトを選択してください。');
    return;
  }

  const stepId = button.dataset.stepId;
  if (!stepId) return;
  const step = (project.steps || []).find((item) => item.stepId === stepId);
  if (!step) {
    showToast('対象手順が見つかりません。');
    return;
  }

  if (button.classList.contains('delete-btn')) {
    safeAction(async () => {
      await sendMessage('DELETE_PROJECT_STEP', {
        projectId: project.projectId,
        stepId
      });
      await refreshProjects();
    }, '手順を削除しました');
    return;
  }

  if (button.classList.contains('edit-btn')) {
    const patch = buildEditPayload(step);
    if (!patch) return;

    safeAction(async () => {
      await sendMessage('UPDATE_PROJECT_STEP', {
        projectId: project.projectId,
        stepId,
        patch
      });
      await refreshProjects();
    }, '手順を更新しました');
  }
});

projectSelect.addEventListener('change', () => {
  renderStepEditor(selectedProject());
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'RUN_LOG_UPDATE') {
    renderRunLog(message.logs);
  }
});

initialize().catch((error) => {
  stateLine.textContent = `初期化失敗: ${error.message}`;
});
