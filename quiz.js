const verbParts = new Set(["v.", "vt.", "vi."]);

function shuffled(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function prepareWord(word, isAnswer, setting) {
  const parts = word.partOfSpeech?.trim().split(/\s*&\s*/) ?? [];
  const meanings = word.chineseMeanings ?? [];
  const headword = word.english.toLowerCase();
  const { partOfSpeech, meaning } = setting?.sense ?? {
    partOfSpeech: parts.length === 1 ? parts[0] : undefined,
    meaning: meanings[0],
  };
  if (isAnswer && (!partOfSpeech || !parts.includes(partOfSpeech) || !meaning || !meanings.includes(meaning))) {
    throw new Error(`無法出題：${word.english} 缺少已對應的詞義與詞性。`);
  }

  const verbForms = word.verbForms ?? setting?.supplementalVerbForms;
  const forms = verbForms ? [verbForms.base, verbForms.past, verbForms.pastParticiple] : [];
  const hasVerbForms = parts.some(part => verbParts.has(part)) &&
    forms[0] === word.english &&
    forms.every(form => typeof form === "string" && form.trim());

  return { word, headword, parts, partOfSpeech, meaning, verbText: hasVerbForms ? forms.join(" / ") : null };
}

function selectOptions(answer, candidates, exclusions) {
  const selected = [answer];
  let bestSize = 1;

  function pick(start) {
    bestSize = Math.max(bestSize, selected.length);
    if (selected.length === 4) return true;
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (selected.some(option => option.headword === candidate.headword ||
          exclusions.get(candidate.word.id)?.has(option.word.id))) continue;

      selected.push(candidate);
      if (pick(index + 1)) return true;
      selected.pop();
    }
    return false;
  }

  if (!pick(0)) {
    throw new Error(`無法出題：${answer.word.english} 只有 ${bestSize} 個有效選項，需要 4 個。`);
  }
  return selected;
}

function createQuestion(answer, pool, random, exclusions) {
  const isVerb = verbParts.has(answer.partOfSpeech);
  if (isVerb && !answer.verbText) {
    throw new Error(`無法出題：${answer.word.english} 缺少完整動詞三態。`);
  }

  const preferred = [];
  const fallback = [];
  for (const candidate of pool) {
    if (candidate.headword === answer.headword ||
        candidate.word.chineseMeanings?.includes(answer.meaning) ||
        (isVerb && !candidate.verbText)) continue;
    const tier = candidate.parts.includes(answer.partOfSpeech) ? preferred : fallback;
    tier.push(candidate);
  }

  const selected = selectOptions(answer, [...shuffled(preferred, random), ...shuffled(fallback, random)], exclusions);
  const options = shuffled(selected, random).map(candidate => {
    // Source headwords provide the singular form for noun options.
    return Object.freeze({
      wordId: candidate.word.id,
      english: candidate.word.english,
      text: isVerb ? candidate.verbText : candidate.word.english,
      isCorrect: candidate === answer,
    });
  });

  return Object.freeze({
    wordId: answer.word.id,
    meaning: answer.meaning,
    partOfSpeech: answer.partOfSpeech,
    options: Object.freeze(options),
  });
}

function getRequestedIds(wordIds, words, unitWordIds) {
  if (!Array.isArray(wordIds) || wordIds.length === 0) {
    throw new Error("無法出題：指定的單字 ID 清單必須是非空陣列。");
  }

  const requested = new Set();
  for (const id of wordIds) {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("無法出題：單字 ID 格式不正確。");
    }
    if (requested.has(id)) throw new Error(`無法出題：指定的單字 ID 重複（${id}）。`);
    if (!unitWordIds.has(id)) {
      const reason = words.some(word => word.id === id) ? "單字 ID 不屬於所選單元" : "找不到單字 ID";
      throw new Error(`無法出題：${reason}（${id}）。`);
    }
    requested.add(id);
  }
  return requested;
}

/** Creates an immutable round. wordIds limits answers only. random returns a number in [0, 1). */
export function createQuiz(words, unitId, { random = Math.random, wordIds, quizSettings } = {}) {
  const unitWords = words.filter(word => word.unitId === unitId);
  const unitWordIds = new Set(unitWords.map(word => word.id));
  const requested = wordIds === undefined ? null : getRequestedIds(wordIds, words, unitWordIds);
  if (unitWords.length === 0) throw new Error("無法出題：所選單元沒有單字。");
  if (unitWords.length < 4) throw new Error("無法出題：所選單元不足 4 個單字。");
  if (unitWordIds.size !== unitWords.length) {
    throw new Error("無法出題：所選單元含有重複的單字 ID。");
  }

  const settings = quizSettings?.wordSettings ?? {};
  const exclusions = new Map();
  for (const [left, right] of quizSettings?.excludedPairs ?? []) {
    if (!unitWordIds.has(left) || !unitWordIds.has(right)) continue;
    if (!exclusions.has(left)) exclusions.set(left, new Set());
    if (!exclusions.has(right)) exclusions.set(right, new Set());
    exclusions.get(left).add(right);
    exclusions.get(right).add(left);
  }

  const pool = unitWords.map(word => prepareWord(word, !requested || requested.has(word.id),
    Object.hasOwn(settings, word.id) ? settings[word.id] : undefined));
  const answers = requested ? pool.filter(candidate => requested.has(candidate.word.id)) : pool;
  const questions = shuffled(answers, random).map(answer => createQuestion(answer, pool, random, exclusions));
  return Object.freeze(questions);
}
