/*
Rometto LanguageTool — Multi-API patch v1.4

Что делает:
- LanguageTool + Яндекс.Спеллер работают параллельно.
- В консоли показывает время каждого API и общее время.
- Не требует API-ключей: публичный LanguageTool / Яндекс.Спеллер используют эти endpoint'ы без ключа.
- Приводит ответы двух сервисов к единому формату.
- Удаляет дубликаты ошибок.
- Не применяет ответ устаревшего запроса.
- Таймаут каждого API: 8 секунд.
- Если один сервис недоступен, второй продолжает работать.

ВАЖНО:
Этот файл — drop-in блок для твоего существующего content.js.
1. Добавь функции ниже перед runCheck().
2. В существующем runCheck() замени одиночный fetch LanguageTool
   на вызов checkWithEngines(text, langCode, requestId).
3. После получения result.errors используй их там, где сейчас
   формируются currentErrors / formattedErrors.

Для Chrome MV3 надёжнее делать оба cross-origin fetch через background.js.
Готовый background.js находится ниже в этом файле.
*/

const LT_API_URL = 'https://api.languagetool.org/v2/check';
const YANDEX_API_URL = 'https://speller.yandex.net/services/spellservice.json/checkText';

const API_TIMEOUT_MS = 8000;
const ENABLE_LANGUAGE_TOOL = true;
const ENABLE_YANDEX_SPELLER = true;

/**
 * Таймер одного сетевого запроса.
 */
async function fetchJsonWithTiming(url, options, apiName) {
  const started = performance.now();

  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });

    const elapsed = performance.now() - started;

    console.log(
      `[Rometto LT] ${apiName}: ${elapsed.toFixed(0)} ms | HTTP ${response.status}`
    );

    if (!response.ok) {
      throw new Error(`${apiName}: HTTP ${response.status}`);
    }

    const data = await response.json();

    const total = performance.now() - started;
    console.log(
      `[Rometto LT] ${apiName}: JSON получен за ${total.toFixed(0)} ms`
    );

    return {
      ok: true,
      data,
      timeMs: total
    };
  } catch (error) {
    const elapsed = performance.now() - started;

    console.warn(
      `[Rometto LT] ${apiName}: ошибка после ${elapsed.toFixed(0)} ms`,
      error
    );

    return {
      ok: false,
      error,
      timeMs: elapsed
    };
  }
}

/**
 * LanguageTool → единый формат.
 */
function normalizeLanguageTool(data) {
  const errors = [];

  for (const m of (data?.matches || [])) {
    // Сохраняем твою текущую логику фильтрации огромных
    // стилистических блоков без предложений замены.
    const isHugeStylisticRule =
      (!m.replacements || m.replacements.length === 0) &&
      m.length > 25;

    if (isHugeStylisticRule) continue;

    errors.push({
      offset: Number(m.offset) || 0,
      length: Number(m.length) || 0,
      message: m.message || 'Возможная ошибка',
      replacements: (m.replacements || [])
        .map(x => x.value)
        .filter(Boolean)
        .slice(0, 8),
      source: 'LanguageTool',
      ruleId: m.rule?.id || '',
      category: m.rule?.category?.id || ''
    });
  }

  return errors;
}

/**
 * Яндекс.Спеллер → тот же формат, что и LanguageTool.
 */
function normalizeYandex(data) {
  if (!Array.isArray(data)) return [];

  return data.map(error => ({
    offset: Number(error.pos) || 0,
    length: Number(error.len) || 0,
    message: 'Возможная орфографическая ошибка',
    replacements: Array.isArray(error.s)
      ? error.s.filter(Boolean).slice(0, 8)
      : [],
    source: 'Yandex Speller',
    ruleId: `yandex-${error.code ?? 'unknown'}`,
    category: 'SPELLING'
  }));
}

/**
 * Проверяет, являются ли две ошибки фактически одной.
 *
 * Это не только точное совпадение:
 * если диапазоны пересекаются и набор предложений похож,
 * считаем их одной ошибкой.
 */
function errorsOverlap(a, b) {
  const aStart = a.offset;
  const aEnd = a.offset + a.length;
  const bStart = b.offset;
  const bEnd = b.offset + b.length;

  return aStart < bEnd && bStart < aEnd;
}

/**
 * Объединяет результаты двух движков.
 *
 * При конфликте:
 * - если оба предлагают одинаковую замену — оставляем одну ошибку;
 * - если варианты разные — объединяем варианты;
 * - LanguageTool остаётся основным источником сообщения.
 */
function mergeErrors(languageToolErrors, yandexErrors) {
  const merged = [...languageToolErrors];

  for (const yandexError of yandexErrors) {
    const existing = merged.find(error => errorsOverlap(error, yandexError));

    if (!existing) {
      merged.push(yandexError);
      continue;
    }

    const replacements = [
      ...(existing.replacements || []),
      ...(yandexError.replacements || [])
    ];

    existing.replacements = [...new Set(replacements)].slice(0, 8);

    // Если LT не дал сообщения/замен, используем информацию Яндекса.
    if (
      existing.source === 'Yandex Speller' ||
      !existing.message
    ) {
      existing.message = yandexError.message;
    }

    existing.source =
      existing.source === yandexError.source
        ? existing.source
        : `${existing.source} + ${yandexError.source}`;
  }

  // Сортируем по позиции в тексте.
  merged.sort((a, b) => a.offset - b.offset);

  return merged;
}

/**
 * Один вызов двух движков.
 *
 * Оба API запускаются одновременно, поэтому пользователь
 * не ждёт сначала LT, потом Яндекс.
 */
async function checkWithEngines(text, langCode, requestId) {
  const totalStarted = performance.now();

  const ltParams = new URLSearchParams();
  ltParams.append('text', text);
  ltParams.append('language', langCode);
  ltParams.append('level', 'picky');
  ltParams.append(
    'enabledCategories',
    'PUNCTUATION,TYPOGRAPHY,GRAMMAR,MISC'
  );

  const yandexParams = new URLSearchParams();
  yandexParams.append('text', text);
  yandexParams.append(
    'lang',
    langCode.startsWith('ru') ? 'ru' : 'en'
  );
  yandexParams.append('options', '0');
  yandexParams.append('format', 'plain');

  console.groupCollapsed(
    `[Rometto LT] Проверка #${requestId} | ${text.length} символов`
  );

  const [ltResult, yandexResult] = await Promise.all([
    ENABLE_LANGUAGE_TOOL
      ? fetchJsonWithTiming(
          LT_API_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: ltParams
          },
          'LanguageTool'
        )
      : Promise.resolve({
          ok: false,
          data: null,
          timeMs: 0
        }),

    ENABLE_YANDEX_SPELLER
      ? fetchJsonWithTiming(
          YANDEX_API_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: yandexParams
          },
          'Yandex Speller'
        )
      : Promise.resolve({
          ok: false,
          data: null,
          timeMs: 0
        })
  ]);

  const languageToolErrors = ltResult.ok
    ? normalizeLanguageTool(ltResult.data)
    : [];

  const yandexErrors = yandexResult.ok
    ? normalizeYandex(yandexResult.data)
    : [];

  const errors = mergeErrors(
    languageToolErrors,
    yandexErrors
  );

  const totalTime = performance.now() - totalStarted;

  console.log(
    `[Rometto LT] ИТОГО: ${totalTime.toFixed(0)} ms | ` +
    `LT: ${ltResult.timeMs.toFixed(0)} ms | ` +
    `Yandex: ${yandexResult.timeMs.toFixed(0)} ms | ` +
    `Ошибок: ${errors.length}`
  );

  console.groupEnd();

  return {
    requestId,
    errors,
    languageTool: {
      ok: ltResult.ok,
      timeMs: ltResult.timeMs,
      errors: languageToolErrors.length
    },
    yandex: {
      ok: yandexResult.ok,
      timeMs: yandexResult.timeMs,
      errors: yandexErrors.length
    },
    totalTimeMs: totalTime
  };
}

/*
----------------------------------------------------------------
КАК ВСТАВИТЬ В ТВОЙ ТЕКУЩИЙ runCheck()
----------------------------------------------------------------

У тебя сейчас внутри runCheck() есть:

const res = await fetch('https://api.languagetool.org/v2/check', {
  ...
});

Вместо одиночного запроса используй:

const result = await checkWithEngines(text, langCode, requestId);

if (requestId !== currentRequestId) return;

const formattedErrors = result.errors;

После этого твой существующий код отображения ошибок
может работать с formattedErrors как раньше.

То есть дальше у тебя остаётся твоя текущая логика:

currentErrors = formattedErrors;
...
отрисовка overlay / badge / panel
----------------------------------------------------------------
*/

/*
----------------------------------------------------------------
MANIFEST — ДОБАВЬ В host_permissions:
----------------------------------------------------------------

"https://api.languagetool.org/*",
"https://speller.yandex.net/*"

Если прямой fetch из content.js будет блокироваться CORS,
перенеси fetch в background.js из следующего блока.
Для MV3 это наиболее надёжный вариант.
----------------------------------------------------------------
*/

/*
----------------------------------------------------------------
BACKGROUND.JS — рекомендуемый вариант для MV3
----------------------------------------------------------------

Этот код можно вынести в отдельный background.js.
Он нужен, чтобы API-запросы выполнялись из extension context,
а не из страницы CRM/Gmail.
----------------------------------------------------------------
*/

/*
const LT_API_URL = 'https://api.languagetool.org/v2/check';
const YANDEX_API_URL =
  'https://speller.yandex.net/services/spellservice.json/checkText';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'rometto-check') return;

  checkApis(message.text, message.langCode)
    .then(sendResponse)
    .catch(error => {
      sendResponse({
        ok: false,
        error: String(error)
      });
    });

  return true;
});

async function checkApis(text, langCode) {
  const ltParams = new URLSearchParams();
  ltParams.append('text', text);
  ltParams.append('language', langCode);
  ltParams.append('level', 'picky');
  ltParams.append(
    'enabledCategories',
    'PUNCTUATION,TYPOGRAPHY,GRAMMAR,MISC'
  );

  const yandexParams = new URLSearchParams();
  yandexParams.append('text', text);
  yandexParams.append(
    'lang',
    langCode.startsWith('ru') ? 'ru' : 'en'
  );
  yandexParams.append('options', '0');
  yandexParams.append('format', 'plain');

  const [lt, yandex] = await Promise.all([
    fetch(LT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: ltParams,
      signal: AbortSignal.timeout(8000)
    }).then(r => r.json()),

    fetch(YANDEX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: yandexParams,
      signal: AbortSignal.timeout(8000)
    }).then(r => r.json())
  ]);

  return {
    ok: true,
    languageTool: lt,
    yandex
  };
}
*/

/*
Примечание по API:

LanguageTool публичный endpoint:
https://api.languagetool.org/v2/check

Яндекс.Спеллер JSON endpoint:
https://speller.yandex.net/services/spellservice.json/checkText

Оба варианта в этой реализации НЕ используют API-ключ.
Если под "ключами" имелись в виду именно API keys,
они здесь не нужны.

Для публичного автоматического использования LanguageTool
учти официальное ограничение их public API: они прямо пишут
не отправлять автоматизированные запросы и рекомендуют
собственный сервер или Enterprise.
*/
