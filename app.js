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

function stepLabel(step) {
  if (step.type === 'copy') {
    const sample = (step.sampleText || '').trim();
    return sample ? `コピー（値を取得） サンプル: ${sample}` : 'コピー（値を取得） サンプル: (未取得)';
  }
  if (step.type === 'paste') {
    return 'ペースト（入力欄へ反映）';
  }
  if (step.type === 'click') {
    return 'クリック（要素を実行）';
  }
  if (step.type === 'select') {
    return `ドロップダウン選択（${step.selectedText || step.selectedValue || '未指定'}）`;
  }
  return `不明ステップ(${step.type})`;
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

    const main = document.createElement('div');
    main.className = 'step-main';
    main.textContent = `手順${index + 1}: ${stepLabel(step)} / ${step.tabRole}`;
    li.appendChild(main);

    const details = document.createElement('details');
    details.className = 'code-detail';
    const summary = document.createElement('summary');
    summary.textContent = 'ソースコード(セレクタ)を表示';
    details.appendChild(summary);
    const code = document.createElement('code');
    code.textContent = step.selector || '(selectorなし)';
    details.appendChild(code);
    li.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'step-actions';

    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.className = 'move-btn';
    upBtn.dataset.stepId = step.stepId;
    upBtn.dataset.direction = 'up';
    upBtn.disabled = index === 0;
    actions.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.textContent = '↓';
    downBtn.className = 'move-btn';
    downBtn.dataset.stepId = step.stepId;
    downBtn.dataset.direction = 'down';
    downBtn.disabled = index === steps.length - 1;
    actions.appendChild(downBtn);

    const editBtn = document.createElement('button');
    editBtn.textContent = '修正(組み直し)';
    editBtn.className = 'edit-btn';
    editBtn.dataset.stepId = step.stepId;
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    deleteBtn.className = 'delete-btn';
    deleteBtn.dataset.stepId = step.stepId;
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
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

  if (button.classList.contains('move-btn')) {
    safeAction(async () => {
      await sendMessage('MOVE_PROJECT_STEP', {
        projectId: project.projectId,
        stepId,
        direction: button.dataset.direction
      });
      await refreshProjects();
    }, '手順を並べ替えました');
    return;
  }

  if (button.classList.contains('edit-btn')) {
    safeAction(async () => {
      await sendMessage('DELETE_PROJECT_STEP', {
        projectId: project.projectId,
        stepId
      });
      await refreshProjects();

      await sendMessage('START_PAIRING', {
        sourceTabId: Number(sourceSelect.value),
        destTabId: Number(destSelect.value)
      });
      await refreshSession();
    }, '手順を削除して組み直しモードを開始しました（コピー元へ移動）');
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
