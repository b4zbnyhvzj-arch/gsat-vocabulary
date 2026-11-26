export const BANK_SCHEMA_VERSION = 1;
export const BANK_STORAGE_KEY = "gsat-vocabulary:bank:v1";

const verbParts = new Set(["v.", "vt.", "vi."]);
const partsOfSpeech = new Set([
  ...verbParts, "n.", "a.", "adj.", "adv.", "pron.", "prep.", "conj.", "interj.", "art.", "det.", "aux.", "phr.",
]);

const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;
const isId = value => isText(value) && value === value.trim();
const optionalText = value => value == null || isText(value);
const optionalCount = (value, minimum) => value == null || (Number.isSafeInteger(value) && value >= minimum);

function onlyFields(object, allowed) {
  return isRecord(object) && Object.keys(object).every(field => allowed.includes(field));
}

function requireBank(condition, message) {
  if (!condition) throw new Error(`題庫格式不正確。 ${message}`);
}

function validForms(forms, word, parts) {
  return onlyFields(forms, ["base", "past", "pastParticiple"]) &&
    forms.base === word.english && isText(forms.past) && isText(forms.pastParticiple) &&
    parts.some(part => verbParts.has(part));
}

function pairKey(pair) {
  return JSON.stringify([...pair].sort());
}

function validateQuizSettings(settings, words, wordParts) {
  requireBank(onlyFields(settings, ["wordSettings", "excludedPairs"]) &&
    isRecord(settings.wordSettings) && Array.isArray(settings.excludedPairs), "缺少出題設定。");

  for (const [id, setting] of Object.entries(settings.wordSettings)) {
    const word = words.get(id);
    requireBank(word && onlyFields(setting, ["sense", "supplementalVerbForms"]), `出題設定引用無效單字 ID（${id}）。`);
    const parts = wordParts.get(id);
    if (Object.hasOwn(setting, "sense")) {
      const sense = setting.sense;
      requireBank(onlyFields(sense, ["partOfSpeech", "meaning"]) && parts.includes(sense.partOfSpeech) &&
        word.chineseMeanings.includes(sense.meaning), `詞義與詞性設定不符合單字（${id}）。`);
    }
    if (Object.hasOwn(setting, "supplementalVerbForms")) {
      requireBank(!word.verbForms && validForms(setting.supplementalVerbForms, word, parts),
        `補充動詞三態無效或與原始資料重複（${id}）。`);
    }
  }

  for (const [id, word] of words) {
    const parts = wordParts.get(id);
    const setting = Object.hasOwn(settings.wordSettings, id) ? settings.wordSettings[id] : undefined;
    requireBank(parts.length === 1 || setting?.sense, `多詞性單字缺少出題詞義與詞性對應（${id}）。`);
    const answerPart = setting?.sense?.partOfSpeech ?? parts[0];
    requireBank(!verbParts.has(answerPart) || word.verbForms || setting?.supplementalVerbForms,
      `動詞缺少完整三態（${id}）。`);
  }

  const seenPairs = new Set();
  for (const pair of settings.excludedPairs) {
    requireBank(Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1] &&
      pair.every(id => words.has(id)) && words.get(pair[0]).unitId === words.get(pair[1]).unitId,
    "歧義排除設定必須引用同單元的兩個不同單字 ID。");
    const key = pairKey(pair);
    requireBank(!seenPairs.has(key), "歧義排除設定重複。");
    seenPairs.add(key);
  }
}

export function validateBank(bank) {
  requireBank(onlyFields(bank, ["schemaVersion", "units", "words", "quizSettings"]) &&
    bank.schemaVersion === BANK_SCHEMA_VERSION, "不支援此 schemaVersion。");
  requireBank(Array.isArray(bank.units) && Array.isArray(bank.words), "units 與 words 必須是陣列。");

  const unitIds = new Set();
  for (const unit of bank.units) {
    requireBank(onlyFields(unit, ["id", "name", "textbook", "level", "unitNumber", "expectedWordCount"]) &&
      isId(unit.id) && isText(unit.name) && optionalText(unit.textbook) &&
      optionalCount(unit.level, 1) && optionalCount(unit.unitNumber, 1) && optionalCount(unit.expectedWordCount, 0),
    "單元 ID、名稱或教材欄位無效。");
    requireBank(!unitIds.has(unit.id), `單元 ID 重複（${unit.id}）。`);
    unitIds.add(unit.id);
  }

  const words = new Map();
  const wordParts = new Map();
  for (const word of bank.words) {
    requireBank(onlyFields(word, ["id", "unitId", "english", "chineseMeanings", "partOfSpeech", "source", "verificationStatus", "verbForms"]) &&
      isId(word.id) && isText(word.english) && Array.isArray(word.chineseMeanings) &&
      word.chineseMeanings.length > 0 && word.chineseMeanings.every(isText),
    "單字 ID、英文或中文意思無效。");
    const id = word.id;
    requireBank(!words.has(id), `單字 ID 重複（${id}）。`);
    requireBank(unitIds.has(word.unitId), `單字對應的單元不存在（${id}）。`);
    const parts = typeof word.partOfSpeech === "string" ? word.partOfSpeech.trim().split(/\s*&\s*/) : [];
    requireBank(parts.length > 0 && parts.every(part => partsOfSpeech.has(part)) &&
      new Set(parts).size === parts.length, `詞性無效（${id}）。`);
    requireBank(["verified", "unverified"].includes(word.verificationStatus) &&
      onlyFields(word.source, ["material", "page"]) && isText(word.source.material) &&
      (isText(word.source.page) || (word.source.page === null && word.verificationStatus === "unverified")),
    `來源或核對狀態無效（${id}）。`);
    if (Object.hasOwn(word, "verbForms")) {
      requireBank(validForms(word.verbForms, word, parts), `原始動詞三態無效（${id}）。`);
    }
    words.set(id, word);
    wordParts.set(id, parts);
  }

  validateQuizSettings(bank.quizSettings, words, wordParts);
  return bank;
}

export function parseBank(text) {
  let bank;
  try {
    bank = JSON.parse(text);
  } catch (cause) {
    throw new Error("題庫檔案不是有效的 JSON。", { cause });
  }
  return validateBank(bank);
}

export function mergeBanks(current, incoming) {
  validateBank(current);
  validateBank(incoming);

  const units = new Map(current.units.map(unit => [unit.id, unit]));
  const words = new Map(current.words.map(word => [word.id, word]));
  for (const unit of incoming.units) units.set(unit.id, unit);
  for (const word of incoming.words) {
    const existing = words.get(word.id);
    if (existing && (existing.unitId !== word.unitId || existing.english !== word.english)) {
      throw new Error(`單字 ID 已屬於其他詞條（${word.id}），無法匯入。`);
    }
    words.set(word.id, word);
  }
  const pairs = new Map([...current.quizSettings.excludedPairs, ...incoming.quizSettings.excludedPairs]
    .map(pair => [pairKey(pair), pair]));

  return validateBank({
    schemaVersion: BANK_SCHEMA_VERSION,
    units: [...units.values()],
    words: [...words.values()],
    quizSettings: {
      wordSettings: { ...current.quizSettings.wordSettings, ...incoming.quizSettings.wordSettings },
      excludedPairs: [...pairs.values()],
    },
  });
}

export function createBankStorage(storage) {
  try {
    if (storage === undefined) storage = globalThis.localStorage;
  } catch (cause) {
    throw new Error("無法存取本機題庫儲存。", { cause });
  }
  if (typeof storage?.getItem !== "function" || typeof storage?.setItem !== "function") {
    throw new Error("本機題庫儲存不可用。");
  }

  function read() {
    let raw;
    try {
      raw = storage.getItem(BANK_STORAGE_KEY);
    } catch (cause) {
      throw new Error("讀取本機題庫失敗。", { cause });
    }
    if (raw === null) return null;
    try {
      return parseBank(raw);
    } catch (cause) {
      throw new Error("本機題庫資料已損毀，原始資料仍保留。", { cause });
    }
  }

  function importBank(current, incoming) {
    const merged = mergeBanks(read() ?? current, incoming);
    try {
      storage.setItem(BANK_STORAGE_KEY, JSON.stringify(merged));
    } catch (cause) {
      throw new Error("儲存本機題庫失敗，原有題庫仍保留。", { cause });
    }
    return merged;
  }

  return { read, importBank };
}
