(() => {
  if (window.__copyPasteMapperLoaded) {
    return;
  }
  window.__copyPasteMapperLoaded = true;

  const state = {
    mode: null,
    active: false,
    hoverEl: null,
    outlineBackup: '',
    badge: null
  };

  function sendMessage(type, payload = {}, callback = () => {}) {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        callback({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      callback(response || { ok: false, error: 'no_response' });
    });
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function getSelector(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${cssEscape(el.id)}`;

    const segments = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      if (current.classList.length) {
        const className = current.classList[0];
        if (className) {
          part += `.${cssEscape(className)}`;
        }
      }
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
        : [];
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      segments.unshift(part);
      current = current.parentElement;
    }
    return segments.join(' > ');
  }

  function removeHoverOutline() {
    if (state.hoverEl) {
      state.hoverEl.style.outline = state.outlineBackup;
      state.hoverEl = null;
      state.outlineBackup = '';
    }
  }

  function setBadge(text) {
    if (!state.badge) {
      const badge = document.createElement('div');
      badge.style.position = 'fixed';
      badge.style.top = '10px';
      badge.style.right = '10px';
      badge.style.zIndex = '2147483647';
      badge.style.background = '#111827';
      badge.style.color = '#fff';
      badge.style.fontSize = '12px';
      badge.style.padding = '6px 10px';
      badge.style.borderRadius = '8px';
      badge.style.boxShadow = '0 2px 6px rgba(0,0,0,0.25)';
      state.badge = badge;
      document.documentElement.appendChild(badge);
    }
    state.badge.textContent = text;
  }

  function hideBadge() {
    if (state.badge) {
      state.badge.remove();
      state.badge = null;
    }
  }

  function startSelection(mode) {
    state.active = true;
    state.mode = mode;
    setBadge(mode === 'copy' ? 'Copy要素をクリック（Escで停止）' : 'Paste inputをクリック（Escで停止）');
  }

  function stopSelection() {
    state.active = false;
    state.mode = null;
    removeHoverOutline();
    hideBadge();
  }

  function pickTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    if (state.mode === 'paste') {
      return target.closest('input, textarea');
    }
    return target;
  }

  document.addEventListener(
    'mousemove',
    (event) => {
      if (!state.active) return;
      const target = pickTarget(event.target);
      if (!target) return;
      if (state.hoverEl !== target) {
        removeHoverOutline();
        state.hoverEl = target;
        state.outlineBackup = target.style.outline;
        target.style.outline = '2px solid #ef4444';
      }
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      if (!state.active) return;
      event.preventDefault();
      event.stopPropagation();

      const target = pickTarget(event.target);
      if (!target) {
        return;
      }

      const selector = getSelector(target);
      const tagName = target.tagName.toLowerCase();
      sendMessage(
        'ELEMENT_SELECTED',
        {
          selector,
          tagName
        },
        (response) => {
          if (!response.ok) {
            setBadge(`エラー: ${response.error}`);
            return;
          }
          stopSelection();
        }
      );
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!state.active) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        stopSelection();
        sendMessage('ESC_PRESSED');
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'START_SELECTION') {
      startSelection(message.mode);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'STOP_SELECTION') {
      stopSelection();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: true });
  });
})();
