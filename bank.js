import {isBaseOnlyVerb} from "./verb-lexicon.js";

export const BANK_SCHEMA_VERSION = 1;
export const BANK_STORAGE_KEY = "gsat-vocabulary:bank:v1";

const verbParts = new Set(["v.", "vt.", "vi."]);
const partsOfSpeech = new Set([
  ...verbParts, "n.", "a.", "adj.", "adv.", "pron.", "prep.", "conj.", "interj.", "art.", "det.", "aux.", "phr.",
]);
const unitFields = ["name", "textbook", "level", "unitNumber", "expectedWordCount"];
const wordFields = ["english", "chineseMeanings", "partOfSpeech", "source", "verificationStatus", "verbForms", "senses", "pendingVerbForms"];

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

function validSenseSource(source) {
  return onlyFields(source, ["material", "page", "image", "raw", "polygon", "width", "height"]) &&
    isText(source.material) && optionalText(source.page) && optionalText(source.image) && optionalText(source.raw) &&
    (source.polygon === undefined || (optionalCount(source.width, 1) && optionalCount(source.height, 1) &&
      source.width > 0 && source.height > 0 && Array.isArray(source.polygon) && source.polygon.length === 4 &&
      source.polygon.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))));
}

function validSenses(senses, word, parts) {
  return Array.isArray(senses) && senses.every(sense =>
    onlyFields(sense, ["partOfSpeech", "meaning", "countability", "plural", "sources"]) &&
    parts.includes(sense.partOfSpeech) && word.chineseMeanings.includes(sense.meaning) &&
    (sense.countability === undefined || (Array.isArray(sense.countability) &&
      sense.countability.every(value => ["countable", "uncountable"].includes(value)))) &&
    (sense.plural == null || ["fixed", "plural"].includes(sense.plural)) &&
    (sense.sources === undefined || (Array.isArray(sense.sources) && sense.sources.every(validSenseSource))));
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
    if(word.pendingVerbForms) {
      requireBank(verbParts.has(answerPart)&&!word.verbForms&&!setting?.supplementalVerbForms,
        "暫不出題的動詞資格無效（"+id+"）。");
    }
    requireBank(!verbParts.has(answerPart) || isBaseOnlyVerb(word.english) || word.verbForms || setting?.supplementalVerbForms || word.pendingVerbForms,
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
    requireBank(onlyFields(unit, ["id", ...unitFields]) &&
      isId(unit.id) && isText(unit.name) && optionalText(unit.textbook) &&
      optionalCount(unit.level, 1) && optionalCount(unit.unitNumber, 1) && optionalCount(unit.expectedWordCount, 0),
    "單元 ID、名稱或教材欄位無效。");
    requireBank(!unitIds.has(unit.id), `單元 ID 重複（${unit.id}）。`);
    unitIds.add(unit.id);
  }

  const words = new Map();
  const wordParts = new Map();
  for (const word of bank.words) {
    requireBank(onlyFields(word, ["id", "unitId", ...wordFields]) &&
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
    requireBank(word.pendingVerbForms===undefined||word.pendingVerbForms===true,"三態待補標記無效。");
    requireBank(word.senses === undefined || validSenses(word.senses, word, parts), "逐義資料無效（"+id+"）。");
    words.set(id, word);
    wordParts.set(id, parts);
  }

  validateQuizSettings(bank.quizSettings, words, wordParts);
  return bank;
}

export const quizReadyWords=words=>words.filter(word=>!word.pendingVerbForms);
export function parseBank(text) {
  let bank;
  try {
    bank = JSON.parse(text);
  } catch (cause) {
    throw new Error("題庫檔案不是有效的 JSON。", { cause });
  }
  return validateBank(bank);
}

export function mergeSenses(...lists) {
  const combined=new Map();
  for(const sense of lists.flat()) {
    const key=JSON.stringify([sense.partOfSpeech,sense.meaning,[...new Set(sense.countability??[])].sort(),sense.plural??null]);
    const previous=combined.get(key);
    if(!previous) combined.set(key,sense);
    else if(previous.sources||sense.sources) {
      const sources=new Map([...previous.sources??[],...sense.sources??[]].map(source=>[JSON.stringify(source),source]));
      combined.set(key,{...previous,sources:[...sources.values()]});
    }
  }
  return [...combined.values()];
}

export function recordHasSense(word, setting) {
  if(!setting || !word.chineseMeanings.includes(setting.meaning) ||
      !word.partOfSpeech.split(/\s*&\s*/).includes(setting.partOfSpeech)) return false;
  const associated=word.senses?.filter(sense=>sense.meaning===setting.meaning);
  return !associated?.length||associated.some(sense=>sense.partOfSpeech===setting.partOfSpeech);
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
    const preserved=existing?.senses?.filter(sense=>recordHasSense({...word,senses:undefined},sense));
    words.set(word.id,preserved?.length?{...word,senses:mergeSenses(word.senses??[],preserved)}:word);
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

const comparisonKey = value => typeof value === "string" ? value.trim().normalize("NFC").toLowerCase() : "";

function newId(prefix, records) {
  let id;
  do {
    const values = crypto.getRandomValues(new Uint32Array(4));
    id = prefix + "-" + Array.from(values, value => value.toString(16).padStart(8, "0")).join("");
  } while (records.some(record => record.id === id));
  return id;
}

function checkDuplicateUnit(units, unit) {
  const duplicate = units.find(other =>
    other.id !== unit.id &&
    comparisonKey(other.textbook) === comparisonKey(unit.textbook) &&
    (other.level ?? null) === (unit.level ?? null) &&
    (other.unitNumber != null && unit.unitNumber != null
      ? other.unitNumber === unit.unitNumber
      : comparisonKey(other.name) === comparisonKey(unit.name))
  );
  if (duplicate) throw new Error(`同一教材分類已有相同的單元（${duplicate.id}）。`);
}

export class DuplicateWordError extends Error {
  constructor(existingWordId, canMerge) {
    const action = canMerge ? "請先確認是否與既有詞條合併。" : "請保留兩筆 ID，選擇不同拼字或編輯既有詞條。";
    super(`同一單元已有相同拼字（${existingWordId}）。${action}`);
    this.name = "DuplicateWordError";
    this.code = "DUPLICATE_WORD";
    this.existingWordId = existingWordId;
    this.canMerge = canMerge;
  }
}

function findDuplicateWord(words, word) {
  const english = comparisonKey(word.english);
  return words.find(other => other.id !== word.id && other.unitId === word.unitId &&
    comparisonKey(other.english) === english);
}

function makeWord(current, fields) {
  const word = { ...current, ...fields };
  if (word.verbForms === null) delete word.verbForms;
  if (word.pendingVerbForms === null) delete word.pendingVerbForms;
  if (current.senses && fields && !Object.hasOwn(fields,"senses")) {
    const parts=word.partOfSpeech.split(/\s*&\s*/);
    word.senses=current.senses.filter(sense=>parts.includes(sense.partOfSpeech)&&word.chineseMeanings.includes(sense.meaning));
  }
  return word;
}

function applyWordSettings(settings, id, changes) {
  if (changes === undefined) return;
  if (changes === null) {
    delete settings[id];
    return;
  }
  requireBank(onlyFields(changes, ["sense", "supplementalVerbForms"]), "單字出題設定無效。");
  const existing = Object.hasOwn(settings, id) ? settings[id] : undefined;
  const next = { ...existing, ...changes };
  for (const key of Object.keys(next)) {
    if (next[key] === null) delete next[key];
  }
  // Define the property directly so legacy IDs such as "__proto__" are treated as data.
  Object.defineProperty(settings, id, { value: next, enumerable: true, configurable: true, writable: true });
}

function applyWordExclusions(settings, id, excludedWordIds, replace) {
  if (excludedWordIds === undefined) return;
  requireBank(Array.isArray(excludedWordIds) && excludedWordIds.every(isId) &&
    new Set(excludedWordIds).size === excludedWordIds.length, "歧義排除單字 ID 清單無效或重複。");
  const existing = replace ? settings.excludedPairs.filter(pair => !pair.includes(id)) : settings.excludedPairs;
  const pairs = new Map(existing.map(pair => [pairKey(pair), pair]));
  for (const otherId of excludedWordIds) {
    const pair = [id, otherId];
    pairs.set(pairKey(pair), pair);
  }
  settings.excludedPairs = [...pairs.values()];
}

function mergeDuplicateWord(bank, existing, draft, changes) {
  // Check the incoming word on its own before preserving the existing source and spelling.
  const singleSettings = { wordSettings: {}, excludedPairs: [] };
  applyWordSettings(singleSettings.wordSettings, draft.id, changes);
  validateBank({
    schemaVersion: bank.schemaVersion,
    units: bank.units,
    words: [draft],
    quizSettings: singleSettings,
  });

  const settings = bank.quizSettings.wordSettings;
  const existingSetting = Object.hasOwn(settings, existing.id) ? settings[existing.id] : undefined;
  let mergedChanges = changes;
  if (changes?.supplementalVerbForms) {
    mergedChanges = {
      ...changes,
      supplementalVerbForms: existing.verbForms ? null : {
        ...changes.supplementalVerbForms, base: existing.english,
      },
    };
  } else if (changes !== null && draft.verbForms && !existing.verbForms &&
      !existingSetting?.supplementalVerbForms) {
    // The draft's source differs from the retained record's source.
    mergedChanges = { ...changes, supplementalVerbForms: { ...draft.verbForms, base: existing.english } };
  }
  applyWordSettings(settings, existing.id, mergedChanges);

  const splitParts = value => value.trim().split(/\s*&\s*/);
  return {
    ...existing,
    ...(existing.senses||draft.senses ? {senses:mergeSenses(existing.senses??[],draft.senses??[])} : {}),
    chineseMeanings: [...new Set([...existing.chineseMeanings, ...draft.chineseMeanings])],
    partOfSpeech: [...new Set([...splitParts(existing.partOfSpeech), ...splitParts(draft.partOfSpeech)])].join(" & "),
    verificationStatus: existing.verificationStatus === "verified" && draft.verificationStatus === "verified"
      ? "verified" : "unverified",
  };
}

/**
 * Builds and validates a dry-run batch without writing storage. Each draft has
 * { word, quizSettings?, excludedWordIds?, mergeIntoWordId? }. Only a confirmed
 * duplicate draft can merge into an existing record, using the ID in the conflict.
 */
export function prepareAddedWords(current, drafts) {
  requireBank(Array.isArray(drafts) && drafts.length > 0, "請提供至少一筆要新增的單字。");
  const bank = structuredClone(validateBank(current));
  for (const draft of drafts) {
    requireBank(onlyFields(draft, ["word", "quizSettings", "excludedWordIds", "mergeIntoWordId"]) &&
      onlyFields(draft.word, ["unitId", ...wordFields]) && isText(draft.word.english), "新增單字欄位無效。");
    const duplicate = findDuplicateWord(bank.words, draft.word);
    if (duplicate && draft.mergeIntoWordId !== duplicate.id) throw new DuplicateWordError(duplicate.id, true);
    if (!duplicate && draft.mergeIntoWordId !== undefined) throw new Error("原合併對象已不存在，請重新確認。");

    const id = duplicate?.id ?? newId("word", bank.words);
    const word = makeWord({ id }, draft.word);
    if (duplicate) {
      const index = bank.words.indexOf(duplicate);
      bank.words[index] = mergeDuplicateWord(bank, duplicate, word, draft.quizSettings);
    } else {
      bank.words.push(word);
      applyWordSettings(bank.quizSettings.wordSettings, id, draft.quizSettings);
    }
    applyWordExclusions(bank.quizSettings, id, draft.excludedWordIds, false);
  }
  return validateBank(bank);
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

  function write(bank) {
    try {
      storage.setItem(BANK_STORAGE_KEY, JSON.stringify(bank));
    } catch (cause) {
      throw new Error("儲存本機題庫失敗，原有題庫仍保留。", { cause });
    }
    return bank;
  }

  function importBank(current, incoming) {
    return write(mergeBanks(read() ?? current, incoming));
  }

  function editBank(current, edit) {
    const bank = structuredClone(validateBank(read() ?? current));
    edit(bank);
    return write(validateBank(bank));
  }

  function addUnit(current, fields) {
    requireBank(onlyFields(fields, unitFields), "新增單元欄位無效。");
    return editBank(current, bank => {
      const unit = { id: newId("unit", bank.units), ...fields };
      checkDuplicateUnit(bank.units, unit);
      bank.units.push(unit);
    });
  }

  function updateUnit(current, unitId, fields) {
    requireBank(onlyFields(fields, unitFields), "編輯單元欄位無效。");
    return editBank(current, bank => {
      const index = bank.units.findIndex(unit => unit.id === unitId);
      if (index < 0) throw new Error(`找不到要編輯的單元（${unitId}）。`);
      const unit = { ...bank.units[index], ...fields };
      checkDuplicateUnit(bank.units, unit);
      bank.units[index] = unit;
    });
  }

  function addWords(current, drafts) {
    return write(prepareAddedWords(read() ?? current, drafts));
  }

  function addWord(current, draft) {
    return addWords(current, [draft]);
  }

  function updateWord(current, wordId, changes) {
    requireBank(onlyFields(changes, ["word", "quizSettings", "excludedWordIds"]) &&
      (changes.word === undefined || onlyFields(changes.word, wordFields)), "編輯單字欄位無效，單字 ID 與單元不可變更。");
    return editBank(current, bank => {
      const index = bank.words.findIndex(word => word.id === wordId);
      if (index < 0) throw new Error(`找不到要編輯的單字（${wordId}）。`);
      const word = makeWord(bank.words[index], changes.word);
      const duplicate = findDuplicateWord(bank.words, word);
      if (duplicate) throw new DuplicateWordError(duplicate.id, false);
      bank.words[index] = word;
      applyWordSettings(bank.quizSettings.wordSettings, wordId, changes.quizSettings);
      applyWordExclusions(bank.quizSettings, wordId, changes.excludedWordIds, true);
    });
  }

  function commitBatch(current, expected, candidate) {
    if (JSON.stringify(read() ?? current) !== expected) {
      throw new Error("題庫已有變更，請重新預覽這次匯入。");
    }
    return write(validateBank(candidate));
  }

  return { read, importBank, commitBatch, addUnit, updateUnit, addWord, addWords, updateWord };
}
