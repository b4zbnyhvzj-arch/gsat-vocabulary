export const STORAGE_KEY = "gsat-vocabulary:v1";

const mistakeFields = ["wordId", "unitId", "missCount", "lastMissedAt", "familiar"];
const resultFields = ["id", "unitId", "completedAt", "totalQuestions", "correctCount", "accuracy"];

function hasFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function isId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  if (typeof value !== "string") return false;

  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validCounts(totalQuestions, correctCount) {
  return Number.isSafeInteger(totalQuestions) && totalQuestions > 0 &&
    Number.isSafeInteger(correctCount) && correctCount >= 0 && correctCount <= totalQuestions;
}

function isMistake(entry) {
  return hasFields(entry, mistakeFields) && isId(entry.wordId) && isId(entry.unitId) &&
    Number.isSafeInteger(entry.missCount) && entry.missCount > 0 &&
    isTimestamp(entry.lastMissedAt) && typeof entry.familiar === "boolean";
}

function isQuizResult(entry) {
  return hasFields(entry, resultFields) && isId(entry.id) && isId(entry.unitId) &&
    isTimestamp(entry.completedAt) && validCounts(entry.totalQuestions, entry.correctCount) &&
    entry.accuracy === entry.correctCount / entry.totalQuestions;
}

function hasValidRecords(entries, isRecord, idField) {
  return Array.isArray(entries) && entries.every(isRecord) &&
    new Set(entries.map(entry => entry[idField])).size === entries.length;
}

/** Uses browser localStorage by default. Tests can pass a Storage-compatible object. */
export function createStudyStorage(storage) {
  try {
    if (storage === undefined) storage = globalThis.localStorage;
  } catch (cause) {
    throw new Error("無法存取本機儲存。", { cause });
  }
  if (typeof storage?.getItem !== "function" || typeof storage?.setItem !== "function") {
    throw new Error("本機儲存不可用。");
  }

  function readState() {
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (cause) {
      throw new Error("讀取本機儲存失敗。", { cause });
    }
    if (raw === null) return { mistakes: [], quizResults: [] };

    let state;
    try {
      state = JSON.parse(raw);
    } catch (cause) {
      throw new Error("本機儲存資料已損毀，無法解析 JSON。", { cause });
    }
    if (!hasFields(state, ["mistakes", "quizResults"]) ||
        !hasValidRecords(state.mistakes, isMistake, "wordId") ||
        !hasValidRecords(state.quizResults, isQuizResult, "id")) {
      throw new Error("本機儲存資料已損毀，紀錄格式或 ID 不正確。");
    }
    return state;
  }

  function writeState(state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (cause) {
      throw new Error("寫入本機儲存失敗。", { cause });
    }
  }

  function recordMistake({ wordId, unitId, lastMissedAt = new Date().toISOString() } = {}) {
    if (!isId(wordId) || !isId(unitId) || !isTimestamp(lastMissedAt)) {
      throw new Error("新增錯題需要有效的單字 ID、單元 ID 與 UTC 時間。");
    }
    const state = readState();
    const existing = state.mistakes.find(entry => entry.wordId === wordId);
    if (existing && existing.unitId !== unitId) {
      throw new Error("此單字 ID 已屬於其他單元。");
    }
    if (existing?.missCount === Number.MAX_SAFE_INTEGER) {
      throw new Error("答錯次數已達可儲存上限。");
    }

    const entry = existing ?? { wordId, unitId, missCount: 0, lastMissedAt, familiar: false };
    entry.missCount++;
    if (Date.parse(lastMissedAt) > Date.parse(entry.lastMissedAt)) entry.lastMissedAt = lastMissedAt;
    entry.familiar = false;
    if (!existing) state.mistakes.push(entry);
    writeState(state);
    return entry;
  }

  function getMistakes(unitId) {
    const { mistakes } = readState();
    return unitId === undefined ? mistakes : mistakes.filter(entry => entry.unitId === unitId);
  }

  function markFamiliar(wordId) {
    const state = readState();
    const entry = state.mistakes.find(mistake => mistake.wordId === wordId);
    if (!entry) throw new Error("找不到指定的錯題紀錄。");

    if (!entry.familiar) {
      entry.familiar = true;
      writeState(state);
    }
    return entry;
  }

  // The caller supplies a stable ID for the round so a retry can reuse it.
  // Accuracy is stored as an unrounded fraction from 0 to 1.
  function saveQuizResult({ id, unitId, completedAt, totalQuestions, correctCount } = {}) {
    if (!isId(id) || !isId(unitId) || !validCounts(totalQuestions, correctCount) ||
        (completedAt !== undefined && !isTimestamp(completedAt))) {
      throw new Error("測驗紀錄的 ID、完成時間或題數不正確。");
    }

    const state = readState();
    const existing = state.quizResults.find(result => result.id === id);
    if (existing) {
      if (existing.unitId !== unitId || existing.totalQuestions !== totalQuestions ||
          existing.correctCount !== correctCount ||
          (completedAt !== undefined && existing.completedAt !== completedAt)) {
        throw new Error("此測驗 ID 已存在，且紀錄內容不同。");
      }
      return existing;
    }

    const result = {
      id, unitId, completedAt: completedAt ?? new Date().toISOString(),
      totalQuestions, correctCount, accuracy: correctCount / totalQuestions,
    };
    state.quizResults.push(result);
    writeState(state);
    return result;
  }

  function getQuizResults() {
    return readState().quizResults;
  }

  return { recordMistake, getMistakes, markFamiliar, saveQuizResult, getQuizResults };
}
