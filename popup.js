const openButton = document.getElementById('open-app');
const statusEl = document.getElementById('status');

openButton.addEventListener('click', () => {
  const appUrl = chrome.runtime.getURL('app.html');
  chrome.tabs.create({ url: appUrl }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `エラー: ${chrome.runtime.lastError.message}`;
      return;
    }
    statusEl.textContent = '固定UIを開きました。';
  });
});
