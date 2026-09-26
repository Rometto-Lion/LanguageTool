(() => {
  let activeElement = null;
  let debounceTimer = null;
  let currentErrors = [];
  let currentText = '';
  let currentRequestId = 0;
  let isInteractingWithPopup = false;

  // Кэш последнего проверенного текста для конкретного элемента —
  // не бьём по API повторно, если текст не изменился (например,
  // пользователь просто кликнул обратно в то же поле).
  let lastCheckedElement = null;
  let lastCheckedText = null;

  // --- Эвристика "это не то поле, которое нужно проверять" -------------
  // Раньше расширение проверяло ЛЮБОЕ текстовое поле на ЛЮБОМ сайте,
  // включая поля поиска, email, телефон, URL, купоны и т.п. Из-за этого
  // бейдж/подсветка вылезали там, где орфография не имеет смысла —
  // в поисковых строках, полях с номерами, промокодами и т.д.
  const NON_PROSE_NAME_REGEX =
    /search|query|\bq\b|url|link|phone|tel|otp|code|captcha|token|zip|postal|username|login|password|e-?mail|coupon|promo|price|amount|quantity|\bqty\b|card|cvv|pin|api[-_]?key/i;

  const MIN_TARGET_WIDTH = 60;
  const MIN_TARGET_HEIGHT = 16;

  // Создаем изолированный контейнер Shadow DOM
  const host = document.createElement('div');
  host.id = 'lt-clone-root';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .lt-highlight-overlay {
      position: absolute;
      pointer-events: none !important;
      color: transparent !important;
      overflow: hidden;
      box-sizing: border-box;
      z-index: 2147483640;
      background: transparent;
      margin: 0;
      user-select: none;
      -webkit-user-select: none;
    }
    .lt-mark-spelling {
      color: transparent !important;
      background: transparent;
      text-decoration: underline wavy #ef4444 2px;
      -webkit-text-decoration: underline wavy #ef4444 2px;
    }
    .lt-mark-grammar {
      color: transparent !important;
      background: rgba(245, 158, 11, 0.12);
      text-decoration: underline wavy #f59e0b 2px;
      -webkit-text-decoration: underline wavy #f59e0b 2px;
      border-radius: 2px;
    }
    .lt-badge {
      position: absolute;
      width: 24px;
      height: 24px;
      background: #10b981;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      z-index: 2147483646;
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      transition: transform 0.15s ease, background 0.2s ease;
    }
    .lt-badge:hover {
      transform: scale(1.1);
    }
    .lt-badge.has-errors {
      background: #ef4444;
    }
    .lt-tooltip, .lt-card-panel {
      position: absolute;
      background: #18181b;
      color: #fafafa;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 10px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      z-index: 2147483647;
      display: none;
      min-width: 220px;
      max-width: 360px;
    }
    .lt-card-panel {
      max-height: 300px;
      overflow-y: auto;
      min-width: 280px;
    }
    .lt-panel-title {
      font-size: 12px;
      font-weight: 700;
      color: #a1a1aa;
      margin-bottom: 8px;
      border-bottom: 1px solid #27272a;
      padding-bottom: 4px;
      display: flex;
      justify-content: space-between;
    }
    .lt-tooltip-msg {
      font-size: 12px;
      color: #e4e4e7;
      margin-bottom: 6px;
      line-height: 1.35;
    }
    .lt-suggestions-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .lt-suggestion-btn {
      background: #27272a;
      color: #4ade80;
      border: 1px solid #3f3f46;
      border-radius: 5px;
      padding: 5px 9px;
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      flex: 1 1 auto;
    }
    .lt-suggestion-btn:hover {
      background: #4ade80;
      color: #09090b;
      border-color: #4ade80;
    }
    .lt-panel-item {
      padding: 8px 0;
      border-bottom: 1px solid #27272a;
    }
    .lt-panel-item:last-child {
      border-bottom: none;
    }
    .lt-fix-all-btn {
      background: #3f3f46;
      color: #fafafa;
      border: 1px solid #52525b;
      border-radius: 6px;
      padding: 8px 12px;
      width: 100%;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 10px;
      transition: background 0.15s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
    }
    .lt-fix-all-btn:hover {
      background: #52525b;
    }
    .lt-fix-all-btn .warning {
      font-size: 10px;
      color: #fbbf24;
      font-weight: 400;
      line-height: 1.2;
    }
  `;
  shadow.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'lt-highlight-overlay';
  shadow.appendChild(overlay);

  const badge = document.createElement('div');
  badge.className = 'lt-badge';
  badge.style.display = 'none';
  shadow.appendChild(badge);

  const tooltip = document.createElement('div');
  tooltip.className = 'lt-tooltip';
  shadow.appendChild(tooltip);

  const panel = document.createElement('div');
  panel.className = 'lt-card-panel';
  shadow.appendChild(panel);

  [tooltip, panel, badge].forEach(el => {
    el.addEventListener('mousedown', () => { isInteractingWithPopup = true; });
    el.addEventListener('mouseup', () => { setTimeout(() => { isInteractingWithPopup = false; }, 100); });
  });

  function handleElementScroll() {
    if (activeElement && isValidTarget(activeElement)) {
      syncOverlayPosition(activeElement);
    }
  }

  function clearAllState() {
    currentRequestId++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (activeElement) {
      activeElement.removeEventListener('scroll', handleElementScroll);
    }
    overlay.innerHTML = '';
    badge.style.display = 'none';
    badge.textContent = '✓';
    badge.classList.remove('has-errors');
    tooltip.style.display = 'none';
    panel.style.display = 'none';
    currentErrors = [];
    currentText = '';
    lastCheckedElement = null;
    lastCheckedText = null;
  }

  function getCleanText(el) {
    if (!el) return '';
    let val = '';
    if (el.isContentEditable) {
      val = (el.innerText || el.textContent || '').replace(/\u200B/g, '');
    } else {
      val = el.value || '';
    }
    return val;
  }

  // Собирает подсказки о том, что это НЕ поле для прозы: имя/id/placeholder/
  // aria-label совпадают с типичными служебными полями (поиск, телефон,
  // купон и т.д.), либо у поля явно слишком маленький размер (иконка поиска
  // в шапке сайта, а не поле для текста).
  function looksLikeNonProseField(el) {
    const hints = [
      el.name, el.id, el.placeholder,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('autocomplete'),
      el.getAttribute && el.getAttribute('role')
    ].filter(Boolean).join(' ');

    if (NON_PROSE_NAME_REGEX.test(hints)) return true;

    if (el.getAttribute && (el.getAttribute('role') === 'searchbox' || el.getAttribute('role') === 'combobox')) {
      return true;
    }

    return false;
  }

  function isValidTarget(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (!document.contains(el)) return false;

    let isSupportedType = false;

    if (el.isContentEditable) {
      isSupportedType = true;
    } else if (el.tagName === 'TEXTAREA') {
      isSupportedType = true;
    } else if (el.tagName === 'INPUT') {
      // Раньше сюда попадали также email/url/tel/search — это НЕ свободный
      // текст, проверять там орфографию/грамматику не нужно и вводит в
      // заблуждение (плюс лишние запросы к публичному API).
      const type = (el.type || 'text').toLowerCase();
      isSupportedType = type === 'text' || type === '';
    }

    if (!isSupportedType) return false;
    if (looksLikeNonProseField(el)) return false;

    // Пропускаем совсем маленькие поля — как правило, это иконки-кнопки
    // поиска в шапке сайта, а не место для текста. Именно из-за таких
    // полей бейдж/подсветка визуально "наезжали" на соседние элементы
    // (например, на фото/логотип рядом с компактным полем поиска).
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_TARGET_WIDTH || rect.height < MIN_TARGET_HEIGHT) return false;

    return true;
  }

  function syncOverlayPosition(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);

    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    overlay.style.fontFamily = computed.fontFamily;
    overlay.style.fontSize = computed.fontSize;
    overlay.style.fontWeight = computed.fontWeight;
    overlay.style.fontStyle = computed.fontStyle;
    overlay.style.lineHeight = computed.lineHeight;
    overlay.style.letterSpacing = computed.letterSpacing;
    overlay.style.wordSpacing = computed.wordSpacing;
    overlay.style.textAlign = computed.textAlign;
    overlay.style.textIndent = computed.textIndent;
    overlay.style.textTransform = computed.textTransform;
    overlay.style.whiteSpace = computed.whiteSpace === 'normal' ? 'pre-wrap' : computed.whiteSpace;
    overlay.style.wordBreak = computed.wordBreak;
    overlay.style.direction = computed.direction;

    overlay.style.paddingTop = computed.paddingTop;
    overlay.style.paddingRight = computed.paddingRight;
    overlay.style.paddingBottom = computed.paddingBottom;
    overlay.style.paddingLeft = computed.paddingLeft;
    // Копируем рамки, чтобы текст совпадал пиксель в пиксель
    overlay.style.borderTopWidth = computed.borderTopWidth;
    overlay.style.borderLeftWidth = computed.borderLeftWidth;
    overlay.style.borderRightWidth = computed.borderRightWidth;
    overlay.style.borderBottomWidth = computed.borderBottomWidth;
    overlay.style.borderStyle = 'solid';
    overlay.style.borderColor = 'transparent';
    overlay.style.boxSizing = computed.boxSizing;

    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;

    // Изменяем позицию бейджа: правый верхний угол (чтобы не перекрывать иконки внутри инпутов справа)
    badge.style.top = `${rect.top + window.scrollY - 10}px`;
    badge.style.left = `${rect.right + window.scrollX - 10}px`;
    badge.style.display = 'flex';
  }

  function hidePopups() {
    tooltip.style.display = 'none';
    panel.style.display = 'none';
  }

  function applyAllFixes() {
    if (!activeElement || !currentText) return;

    const fixableErrors = currentErrors
      .filter(err => err.replacements && err.replacements.length > 0)
      .sort((a, b) => b.offset - a.offset); // Идем с конца, чтобы оффсеты не съезжали

    if (fixableErrors.length === 0) return;

    let newText = currentText;
    for (const err of fixableErrors) {
      const rep = err.replacements[0];
      newText = newText.slice(0, err.offset) + rep + newText.slice(err.offset + err.length);
    }

    activeElement.focus();
    if ('setSelectionRange' in activeElement && typeof activeElement.selectionStart === 'number') {
      activeElement.setSelectionRange(0, activeElement.value.length);
      const success = document.execCommand('insertText', false, newText);
      if (!success) {
        activeElement.value = newText;
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (activeElement.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(activeElement);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const success = document.execCommand('insertText', false, newText);
      if (!success) {
        activeElement.innerText = newText;
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    hidePopups();
    lastCheckedText = null; // сбрасываем кэш, чтобы форсировать новую проверку
    runCheck(activeElement);
  }

  function getTextNodesUnder(el) {
    const textNodes = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    let n;
    while ((n = walk.nextNode())) textNodes.push(n);
    return textNodes;
  }

  function setContentEditableRange(el, start, end) {
    const textNodes = getTextNodesUnder(el);
    let currentOffset = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;

    for (const node of textNodes) {
      const nodeLen = node.textContent.length;
      if (!startNode && currentOffset + nodeLen >= start) {
        startNode = node;
        startNodeOffset = Math.max(0, start - currentOffset);
      }
      if (!endNode && currentOffset + nodeLen >= end) {
        endNode = node;
        endNodeOffset = Math.min(nodeLen, end - currentOffset);
        break;
      }
      currentOffset += nodeLen;
    }

    if (startNode && endNode) {
      const range = document.createRange();
      range.setStart(startNode, startNodeOffset);
      range.setEnd(endNode, endNodeOffset);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return range;
    }
    return null;
  }

  function replaceText(offset, length, newText) {
    if (!activeElement) return;
    activeElement.focus();

    if ('setSelectionRange' in activeElement && typeof activeElement.selectionStart === 'number') {
      // Обычные поля ввода (textarea, input)
      activeElement.setSelectionRange(offset, offset + length);
      const success = document.execCommand('insertText', false, newText);

      const newCursorPos = offset + newText.length;
      if (!success) {
        const full = activeElement.value || '';
        activeElement.value = full.slice(0, offset) + newText + full.slice(offset + length);
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
      activeElement.setSelectionRange(newCursorPos, newCursorPos);
    } else if (activeElement.isContentEditable) {
      // Редакторы сообщений в мессенджерах (contenteditable)
      const range = setContentEditableRange(activeElement, offset, offset + length);
      let replaced = false;

      if (range) {
        replaced = document.execCommand('insertText', false, newText);
      }

      if (!replaced) {
        if (range) {
          range.deleteContents();
          const newNode = document.createTextNode(newText);
          range.insertNode(newNode);

          // Ставим курсор сразу после вставленного текста
          const sel = window.getSelection();
          const newRange = document.createRange();
          newRange.setStartAfter(newNode);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
        } else {
          const full = getCleanText(activeElement);
          activeElement.innerText = full.slice(0, offset) + newText + full.slice(offset + length);
        }
        activeElement.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    hidePopups();
    lastCheckedText = null; // текст изменился — форсируем повторную проверку
    runCheck(activeElement);
  }

  function showTooltipAt(clickX, clickY, err) {
    panel.style.display = 'none';
    tooltip.innerHTML = '';

    const msg = document.createElement('div');
    msg.className = 'lt-tooltip-msg';
    msg.textContent = err.message || 'Ошибка';
    tooltip.appendChild(msg);

    const suggestionsGrid = document.createElement('div');
    suggestionsGrid.className = 'lt-suggestions-grid';

    if (!err.replacements || err.replacements.length === 0) {
      const empty = document.createElement('div');
      empty.style.fontSize = '11px';
      empty.style.color = '#71717a';
      empty.textContent = 'Нет вариантов замены';
      tooltip.appendChild(empty);
    } else {
      err.replacements.slice(0, 4).forEach(rep => {
        const btn = document.createElement('button');
        btn.className = 'lt-suggestion-btn';
        btn.textContent = rep;
        btn.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          replaceText(err.offset, err.length, rep);
        };
        suggestionsGrid.appendChild(btn);
      });
      tooltip.appendChild(suggestionsGrid);
    }

    tooltip.style.display = 'block';

    const tooltipHeight = tooltip.offsetHeight || 60;
    let top = window.scrollY + clickY - tooltipHeight - 12;
    let left = window.scrollX + clickX - 20;

    if (top < window.scrollY + 10) {
      top = window.scrollY + clickY + 20;
    }
    if (left + 260 > window.innerWidth) {
      left = window.innerWidth - 270;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${Math.max(10, left)}px`;
  }

  function showAllErrorsPanel(badgeRect) {
    tooltip.style.display = 'none';
    panel.innerHTML = `
      <div class="lt-panel-title">
        <span>Найдено проблем: ${currentErrors.length}</span>
      </div>
    `;

    if (!currentErrors.length) {
      panel.innerHTML += `<div style="color:#4ade80;font-size:12px;">Ошибок не обнаружено ✓</div>`;
    } else {
      const fixableCount = currentErrors.filter(e => e.replacements && e.replacements.length > 0).length;
      if (fixableCount > 0) {
        const fixAllBtn = document.createElement('button');
        fixAllBtn.className = 'lt-fix-all-btn';
        fixAllBtn.innerHTML = `
          <span>Исправить всё (${fixableCount})</span>
          <span class="warning">⚠️ Внимание: обязательно проверьте текст после автозамены!</span>
        `;
        fixAllBtn.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyAllFixes();
        };
        panel.appendChild(fixAllBtn);
      }

      currentErrors.forEach((err) => {
        const item = document.createElement('div');
        item.className = 'lt-panel-item';

        const textSnippet = currentText.slice(err.offset, err.offset + err.length) || 'Пропуск знака';
        const msg = document.createElement('div');
        msg.className = 'lt-tooltip-msg';
        msg.innerHTML = `<b>${escapeHtml(textSnippet)}</b>: ${escapeHtml(err.message)}`;
        item.appendChild(msg);

        if (err.replacements && err.replacements.length > 0) {
          const grid = document.createElement('div');
          grid.className = 'lt-suggestions-grid';

          err.replacements.slice(0, 4).forEach(rep => {
            const btn = document.createElement('button');
            btn.className = 'lt-suggestion-btn';
            btn.textContent = rep;
            btn.onmousedown = (e) => {
              e.preventDefault();
              e.stopPropagation();
              replaceText(err.offset, err.length, rep);
            };
            grid.appendChild(btn);
          });

          item.appendChild(grid);
        }

        panel.appendChild(item);
      });
    }

    panel.style.display = 'block';
    panel.style.top = `${window.scrollY + badgeRect.top - panel.offsetHeight - 8}px`;
    panel.style.left = `${window.scrollX + badgeRect.right - panel.offsetWidth}px`;
  }

  badge.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel.style.display === 'block') {
      hidePopups();
    } else {
      showAllErrorsPanel(badge.getBoundingClientRect());
    }
  });

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  }

  function renderHighlights(text, errors) {
    currentText = text;
    currentErrors = errors;

    if (!errors.length) {
      overlay.innerHTML = '';
      badge.textContent = '✓';
      badge.classList.remove('has-errors');
      hidePopups();
      return;
    }

    badge.textContent = errors.length;
    badge.classList.add('has-errors');

    let html = '';
    let lastIdx = 0;

    errors.sort((a, b) => a.offset - b.offset).forEach((err, index) => {
      html += escapeHtml(text.slice(lastIdx, err.offset));

      let word = text.slice(err.offset, err.offset + err.length);
      if (!word) word = ' ';

      const markClass = err.type === 'grammar' ? 'lt-mark-grammar' : 'lt-mark-spelling';
      html += `<span class="${markClass}" data-err-idx="${index}">${escapeHtml(word)}</span>`;
      lastIdx = err.offset + err.length;
    });
    html += escapeHtml(text.slice(lastIdx));

    overlay.innerHTML = html;
  }

  function getCaretOffset(target, clickX, clickY) {
    if (!target) return -1;
    if (target.isContentEditable) {
      let range = null;
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(clickX, clickY);
      } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(clickX, clickY);
        // pos может быть null (например, клик пришёлся на картинку/пустую
        // область внутри contenteditable) — раньше это падало с TypeError.
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
      if (range) {
        const preRange = document.createRange();
        preRange.selectNodeContents(target);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length;
      }
    } else if (typeof target.selectionStart === 'number') {
      return target.selectionStart;
    }
    return -1;
  }

  // Отправляет текст в background.js, который параллельно опрашивает
  // LanguageTool и Яндекс.Спеллер и возвращает уже объединённый список ошибок.
  function checkWithEngines(text, langCode, requestId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'rometto-check', text, langCode, requestId },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Rometto LT] Не удалось связаться с background.js:', chrome.runtime.lastError.message);
            resolve({ requestId, ok: false, errors: [] });
            return;
          }
          resolve(response || { requestId, ok: false, errors: [] });
        }
      );
    });
  }

  async function runCheck(target) {
    if (!isValidTarget(target)) return;
    const text = getCleanText(target);
    if (text.trim().length < 2) {
      clearAllState();
      return;
    }

    // Оптимизация: не бьём по API повторно, если текст в этом же элементе
    // не изменился с прошлой проверки (например, просто вернулись фокусом).
    if (target === lastCheckedElement && text === lastCheckedText) {
      return;
    }

    const requestId = ++currentRequestId;
    syncOverlayPosition(target);

    const isRussian = /[а-яёА-ЯЁ]/.test(text);
    const langCode = isRussian ? 'ru-RU' : 'en-US';

    const result = await checkWithEngines(text, langCode, requestId);
    if (requestId !== currentRequestId) return; // пришёл ответ на устаревший запрос

    const currentVal = getCleanText(target);
    if (currentVal.trim().length < 2) {
      clearAllState();
      return;
    }
    if (currentVal !== text) return; // текст успел измениться, ждём следующего debounce

    if (!result || !result.ok) {
      console.warn('[Rometto LT] Оба сервиса недоступны, проверка пропущена');
      return;
    }

    lastCheckedElement = target;
    lastCheckedText = text;

    let formattedErrors = (result.errors || []).map(err => {
      let replacements = err.replacements || [];
      const snippet = text.slice(err.offset, err.offset + err.length);

      if (replacements.length === 0 && /[а-яё]\s+[А-ЯЁ]/.test(snippet)) {
        const parts = snippet.split(/\s+/);
        if (parts.length >= 2) {
          replacements = [
            `${parts[0]}. ${parts[1]}`,
            `${parts[0]}, ${parts[1].toLowerCase()}`
          ];
        }
      } else if (replacements.length === 0 && /^[А-ЯЁ][а-яё]+$/.test(snippet)) {
        replacements = [
          `. ${snippet}`,
          snippet.toLowerCase()
        ];
      }

      return { ...err, replacements };
    });

    // Детектор обращений (Имя + приветствие)
    if (isRussian) {
      const greetingRegex = /\b([А-ЯЁ][а-яё]+)\s+(здравствуй[тте]*|привет|добрый\s+день|доброе\s+утро|добрый\s+вечер)\b/gui;
      let match;
      while ((match = greetingRegex.exec(text)) !== null) {
        const name = match[1];
        const hasComma = text.slice(match.index, match.index + match[0].length).includes(',');

        if (!hasComma) {
          const offset = match.index;
          const length = match[0].length;

          formattedErrors = formattedErrors.filter(e => !(e.offset >= offset && e.offset + e.length <= offset + length));

          formattedErrors.push({
            offset: offset,
            length: length,
            message: `После обращения «${name}» пропущена запятая.`,
            replacements: [
              `${name}, здравствуйте`,
              `${name}, здравствуй`,
              `${name}, добрый день`
            ],
            type: 'grammar'
          });
        }
      }
    }

    renderHighlights(text, formattedErrors);
  }

  function handleInputEvent(e) {
    if (!isValidTarget(e.target)) return;
    const text = getCleanText(e.target);
    syncOverlayPosition(e.target); // Сразу синхронизируем скролл и размер, чтобы подсветка не съезжала при наборе
    if (text.trim().length < 2) {
      clearAllState();
      return;
    }
    activeElement = e.target;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(e.target), 450);
  }

  document.addEventListener('input', handleInputEvent);
  document.addEventListener('cut', (e) => setTimeout(() => handleInputEvent(e), 20));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && isValidTarget(e.target)) {
      setTimeout(() => {
        const text = getCleanText(e.target);
        if (text.trim().length < 2) {
          clearAllState();
        }
      }, 50);
    }
  });

  document.addEventListener('submit', () => {
    clearAllState();
  }, true);

  document.addEventListener('focusin', (e) => {
    if (!isValidTarget(e.target)) {
      clearAllState();
      return;
    }
    
    // Очищаем старый слушатель, если мы переключились между полями
    if (activeElement) {
      activeElement.removeEventListener('scroll', handleElementScroll);
    }
    
    activeElement = e.target;
    // Подписываемся на внутренний скролл элемента
    activeElement.addEventListener('scroll', handleElementScroll, { passive: true });

    const text = getCleanText(e.target);
    if (text.trim().length >= 2) {
      syncOverlayPosition(e.target);
      // Debounce и здесь: раньше проверка запускалась мгновенно на КАЖДЫЙ
      // фокус, включая переход по Tab между уже заполненными полями формы —
      // это и создавало ощущение, что расширение "лезет" куда не просили.
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runCheck(e.target), 150);
    } else {
      clearAllState();
    }
  });

  document.addEventListener('focusout', (e) => {
    // Если элемент, за которым мы следили, исчез из DOM (например, SPA
    // заменила разметку компоузера), явно прячем оверлей/бейдж, а не
    // оставляем их "висеть" поверх остального контента страницы.
    setTimeout(() => {
      if (activeElement && !document.contains(activeElement)) {
        clearAllState();
        activeElement = null;
      }
    }, 0);
  });

  // Клик по тексту определяет попадание в ошибку без блокировки курсора
  document.addEventListener('click', (e) => {
    if (isInteractingWithPopup) return;

    if (e.target !== host && !host.contains(e.target)) {
      if (isValidTarget(e.target) && currentErrors.length > 0) {
        // Небольшая задержка, чтобы браузер успел поставить нативный курсор
        setTimeout(() => {
          const offset = getCaretOffset(e.target, e.clientX, e.clientY);
          if (offset >= 0) {
            const clickedErr = currentErrors.find(err => offset >= err.offset && offset <= err.offset + err.length);
            if (clickedErr) {
              showTooltipAt(e.clientX, e.clientY, clickedErr);
              return;
            }
          }
          hidePopups();
        }, 10);
      } else {
        hidePopups();
      }
    }
  });

  window.addEventListener('scroll', () => {
    if (activeElement) {
      if (!document.contains(activeElement)) {
        clearAllState();
        activeElement = null;
        return;
      }
      if (isValidTarget(activeElement)) syncOverlayPosition(activeElement);
    }
  }, true);

  window.addEventListener('resize', () => {
    if (activeElement && isValidTarget(activeElement)) syncOverlayPosition(activeElement);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (activeElement && isValidTarget(activeElement)) syncOverlayPosition(activeElement);
    });
    window.visualViewport.addEventListener('scroll', () => {
      if (activeElement && isValidTarget(activeElement)) syncOverlayPosition(activeElement);
    });
  }

  // Если элемент, за которым следим, удаляется из DOM (частая ситуация в
  // SPA — React/Vue пересобирают форму), сразу же прячем оверлей/бейдж,
  // а не оставляем их зависшими поверх новой разметки (в том числе поверх
  // соседних картинок/фото, если бейдж оказался там же по координатам).
  const cleanupObserver = new MutationObserver(() => {
    if (activeElement && !document.contains(activeElement)) {
      clearAllState();
      activeElement = null;
    }
  });
  cleanupObserver.observe(document.documentElement, { childList: true, subtree: true });
  // --- я устал... 
})();
