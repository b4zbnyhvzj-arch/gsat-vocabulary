import {isBaseOnlyVerb} from "./verb-lexicon.js";
import { createQuiz } from "./quiz.js";
import { createStudyStorage, STORAGE_KEY } from "./storage.js";
import {
  BANK_SCHEMA_VERSION, BANK_STORAGE_KEY, DuplicateWordError, createBankStorage, mergeBanks, parseBank, validateBank, quizReadyWords,
} from "./bank.js";

const home = document.querySelector("#home");
const detail = document.querySelector("#unit-detail");
const detailTitle = document.querySelector("#detail-title");
const detailCount = document.querySelector("#detail-count");
const loadStatus = document.querySelector("#load-status");
const numberFormat = new Intl.NumberFormat("zh-TW");
const accuracyFormat = new Intl.NumberFormat("zh-TW", { style: "percent", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" });
const quizScreen = document.querySelector("#quiz-screen");
const resultScreen = document.querySelector("#result-screen");
const reviewScreen = document.querySelector("#review-screen");
const reviewContent = document.querySelector("#review-content");
const reviewUnit = document.querySelector("#review-unit");
const reviewStatus = document.querySelector("#review-status");
const reviewList = document.querySelector("#review-list");
const reviewEmpty = document.querySelector("#review-empty");
const reviewStart = document.querySelector("#start-review-quiz");
const reviewQuizCount = document.querySelector("#review-quiz-count");
const reviewQuizNote = document.querySelector("#review-quiz-note");
const reviewQuizError = document.querySelector("#review-quiz-error");
const resultBack = document.querySelector("#result-back");
const unitsTab = document.querySelector("#units-tab");
const reviewTab = document.querySelector("#review-tab");
const storageWarning = document.querySelector("#storage-warning");
const bankFile = document.querySelector("#bank-file");
const bankPreview = document.querySelector("#bank-preview");
const bankPreviewSummary = document.querySelector("#bank-preview-summary");
const bankStatus = document.querySelector("#bank-status");
const chooseBank = document.querySelector("#choose-bank");
const quizError = document.querySelector("#quiz-error");
const startQuizButton = document.querySelector("#start-quiz");
const unitEditor = document.querySelector("#unit-editor");
const unitForm = document.querySelector("#unit-form");
const wordManager = document.querySelector("#word-manager");
const wordSearch = document.querySelector("#word-search");
const wordEditor = document.querySelector("#word-editor");
const wordForm = document.querySelector("#word-form");
const wordAdvanced = document.querySelector("#word-advanced");
const wordDuplicate = document.querySelector("#word-duplicate");
const formParts = ["n.", "v.", "vt.", "vi.", "a.", "adj.", "adv.", "pron.", "prep.", "conj.",
  "interj.", "art.", "det.", "aux.", "phr."];
const verbParts = new Set(["v.", "vt.", "vi."]);
const questionMeaning = document.querySelector("#question-meaning");
const progressBar = document.querySelector("#quiz-progress-bar");
const optionList = document.querySelector("#quiz-options");
const feedback = document.querySelector("#quiz-feedback");
const nextButton = document.querySelector("#next-question");
const letters = ["A", "B", "C", "D"];
const unitNames = new Map();
const wordsById = new Map();
const unitQuizErrors = new Map();
const writeWarnings = new Map();
let activeBank = null;
let pendingBank = null;
let bankReadSequence = 0;
let studyStorage;
let readWarning = "";
let selectedUnitId = null;
let editor = null;
let duplicateDraft = null;
let round = null;
let lastResultWasReview = false;
const photoScreen = document.querySelector("#photo-import");
let photoSession;

function formatWordCount(count) {
  return `${numberFormat.format(count)} 個單字`;
}

function unitWordCounts(total, ready) {
  return `收錄 ${formatWordCount(total)} · 可出題 ${formatWordCount(ready)}`;
}

function selectedUnitWords() {
  return activeBank.words.filter(word => word.unitId === selectedUnitId);
}

function showScreen(screen) {
  for (const view of [home, detail, quizScreen, resultScreen, reviewScreen, unitEditor, wordManager, wordEditor, photoScreen]) {
    view.hidden = view !== screen;
  }
  const onReviewTab = screen === reviewScreen ||
    (screen === quizScreen && round?.isReview) ||
    (screen === resultScreen && lastResultWasReview);
  const active = onReviewTab ? reviewTab : unitsTab;
  for (const tab of [unitsTab, reviewTab]) {
    tab.classList.toggle("tab-active", tab === active);
    if (tab === active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}

function showUnitDetail() {
  const message = unitQuizErrors.get(selectedUnitId) ?? "";
  detailTitle.textContent = unitNames.get(selectedUnitId);
  const words = selectedUnitWords();
  detailCount.textContent = unitWordCounts(words.length, message ? 0 : quizReadyWords(words).length);
  startQuizButton.disabled = Boolean(message);
  quizError.hidden = !message;
  quizError.textContent = message;
  showScreen(detail);
  window.scrollTo(0, 0);
  detailTitle.focus();
}

function showHome() {
  if (!photoScreen.hidden || !home.hidden || reviewTab.disabled || !confirmLeaveRound() || !confirmLeaveEditor()) return;

  showScreen(home);
  const row = Array.from(document.querySelectorAll(".unit-row"))
    .find(button => button.dataset.unitId === selectedUnitId);
  (row ?? unitsTab).focus();
  selectedUnitId = null;
}

function warnOnUnload(event) {
  event.preventDefault();
  event.returnValue = true;
}

function discardRound() {
  if (!round) return;
  window.clearTimeout(round.timer);
  window.removeEventListener("beforeunload", warnOnUnload);
  round = null;
}

function confirmLeaveRound() {
  if (round && !window.confirm("要放棄本輪測驗嗎？")) return false;
  discardRound();
  return true;
}

function newRoundId() {
  // getRandomValues is available on the local HTTP preview, including the LAN address.
  const values = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, value => value.toString(16).padStart(8, "0")).join("");
}

function startQuiz() {
  if (selectedUnitId !== null) launchQuiz(selectedUnitId);
}

function launchQuiz(unitId, wordIds) {
  if (round) return;
  const isReview = wordIds !== undefined;

  let questions;
  try {
    questions = createQuiz(quizReadyWords(activeBank.words), unitId, { wordIds, quizSettings: activeBank.quizSettings });
  } catch (error) {
    if (!isReview) showUnitDetail();
    const target = isReview ? reviewQuizError : quizError;
    target.hidden = false;
    target.textContent = error.message;
    return;
  }

  round = {
    id: newRoundId(),
    unitId, isReview,
    questions, index: 0, correctCount: 0, mistakes: [], answer: null, timer: null,
  };
  window.addEventListener("beforeunload", warnOnUnload);
  document.querySelector("#quiz-title").textContent = unitNames.get(unitId);
  document.querySelector("#quiz-mode").hidden = !isReview;
  const unitWords = activeBank.words.filter(word => word.unitId === unitId);
  document.querySelector("#quiz-coverage").textContent = unitWordCounts(unitWords.length, quizReadyWords(unitWords).length);
  progressBar.max = questions.length;
  showScreen(quizScreen);
  showQuestion();
}

function showQuestion() {
  const currentRound = round;
  const { index, questions } = currentRound;
  const question = questions[index];
  document.querySelector("#question-count").textContent = `第 ${index + 1} 題／共 ${questions.length} 題`;
  progressBar.value = index;
  document.querySelector("#question-pos").textContent = `詞性 ${question.partOfSpeech}`;
  questionMeaning.textContent = question.meaning;
  feedback.className = "quiz-feedback";
  feedback.textContent = "";
  nextButton.hidden = true;

  const buttons = question.options.map((option, position) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiz-option";
    const letter = document.createElement("span");
    letter.className = "quiz-option-letter";
    letter.textContent = letters[position];
    const text = document.createElement("span");
    text.className = "quiz-option-text";
    text.textContent = option.text;
    button.append(letter, text);
    button.addEventListener("click", () => answerQuestion(currentRound, index, position));
    return button;
  });
  optionList.replaceChildren(...buttons);
  window.scrollTo(0, 0);
  questionMeaning.focus({ preventScroll: true });
}

function answerQuestion(currentRound, index, position) {
  if (round !== currentRound || round.index !== index || round.answer !== null) return;

  const question = round.questions[index];
  const correctPosition = question.options.findIndex(option => option.isCorrect);
  const correct = question.options[correctPosition];
  const isCorrect = position === correctPosition;
  round.answer = isCorrect ? "correct" : "wrong";
  progressBar.value = index + 1;

  const buttons = optionList.children;
  for (const button of buttons) button.disabled = true;
  buttons[correctPosition].classList.add("is-correct");
  if (isCorrect) {
    round.correctCount++;
    feedback.classList.add("is-correct");
    feedback.textContent = "答對了！";
    round.timer = window.setTimeout(() => {
      if (round === currentRound && round.index === index) advanceQuestion();
    }, 400);
    return;
  }

  round.mistakes.push({ english: correct.english, meaning: question.meaning });
  storeChange("本次錯題未儲存。", storage => {
    storage.recordMistake({ wordId: correct.wordId, unitId: currentRound.unitId });
  });
  buttons[position].classList.add("is-wrong");
  feedback.classList.add("is-wrong");
  feedback.textContent = `答錯了。正確答案是 ${letters[correctPosition]} · ${correct.text}`;
  nextButton.hidden = false;
  nextButton.focus({ preventScroll: true });
}

function advanceQuestion() {
  window.clearTimeout(round.timer);
  round.timer = null;
  round.index++;
  round.answer = null;
  if (round.index === round.questions.length) {
    const completed = round;
    discardRound();
    if (!completed.isReview) {
      storeChange("本輪成績未儲存。", storage => {
        storage.saveQuizResult({
          id: completed.id,
          unitId: completed.unitId,
          totalQuestions: completed.questions.length,
          correctCount: completed.correctCount,
        });
      });
    }
    showResults(completed);
  } else {
    showQuestion();
  }
}

function showResults(completed) {
  const { unitId, isReview, questions, correctCount, mistakes } = completed;
  const total = questions.length;
  lastResultWasReview = isReview;
  document.querySelector("#result-title").textContent = isReview ? "錯題測驗完成" : "測驗完成";
  document.querySelector("#result-unit").textContent = unitNames.get(unitId);
  resultBack.textContent = isReview ? "返回錯題本" : "返回單元";
  document.querySelector("#correct-total").textContent = `${correctCount} / ${total}`;
  document.querySelector("#wrong-total").textContent = mistakes.length;
  document.querySelector("#accuracy").textContent = accuracyFormat.format(correctCount / total);
  document.querySelector("#quiz-passed").hidden = isReview || correctCount * 100 < total * 96;

  const items = mistakes.map(({ english, meaning }) => {
    const item = document.createElement("li");
    const word = document.createElement("strong");
    word.textContent = english;
    const definition = document.createElement("span");
    definition.textContent = meaning;
    item.append(word, definition);
    return item;
  });
  const list = document.querySelector("#mistake-list");
  list.replaceChildren(...items);
  list.hidden = items.length === 0;
  document.querySelector("#no-mistakes").hidden = items.length > 0;
  showScreen(resultScreen);
  window.scrollTo(0, 0);
  document.querySelector("#result-title").focus();
}

function updateStorageWarning() {
  const messages = [readWarning, ...writeWarnings.values()].filter(Boolean);
  storageWarning.hidden = messages.length === 0;
  const text = messages.join(" ");
  if (storageWarning.textContent !== text) storageWarning.textContent = text;
}

function getStudyStorage() {
  studyStorage ??= createStudyStorage();
  return studyStorage;
}

function readMistakes(unitId) {
  try {
    const records = getStudyStorage().getMistakes(unitId);
    readWarning = "";
    updateStorageWarning();
    return records;
  } catch (error) {
    readWarning = `無法讀取錯題本。 ${error.message}`;
    updateStorageWarning();
    return null;
  }
}

function storeChange(message, action) {
  try {
    action(getStudyStorage());
    return true;
  } catch (error) {
    writeWarnings.set(message, `${message} ${error.message}`);
    updateStorageWarning();
    return false;
  }
}

function createReviewRow(record) {
  const entry = wordsById.get(record.wordId);
  const word = entry?.unitId === record.unitId ? entry : null;
  const item = document.createElement("li");
  item.className = "review-card";

  const title = document.createElement("h3");
  title.textContent = word?.english ?? "題庫單字缺失";
  title.lang = word ? "en" : "zh-Hant";
  const meaning = document.createElement("p");
  meaning.className = word ? "review-meaning" : "review-missing";
  meaning.textContent = word
    ? `${word.partOfSpeech ?? "詞性待核對"} · ${word.chineseMeanings.join("；")}`
    : `找不到單字 ID ${record.wordId}，錯題紀錄仍保留。`;

  const metadata = document.createElement("div");
  metadata.className = "review-meta";
  const unit = document.createElement("span");
  unit.textContent = unitNames.get(record.unitId) ?? record.unitId;
  const count = document.createElement("span");
  count.textContent = `答錯 ${numberFormat.format(record.missCount)} 次`;
  const latest = document.createElement("time");
  latest.dateTime = record.lastMissedAt;
  latest.textContent = `最近答錯 ${dateFormat.format(new Date(record.lastMissedAt))}`;
  metadata.append(unit, count, latest);
  item.append(title, meaning, metadata);

  if (record.familiar) {
    const badge = document.createElement("span");
    badge.className = "review-familiar";
    badge.textContent = "已熟悉";
    item.append(badge);
  } else {
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "quiz-button";
    mark.textContent = "標記已熟悉";
    mark.setAttribute("aria-label", `標記 ${word?.english ?? record.wordId} 為已熟悉`);
    mark.addEventListener("click", () => {
      if (storeChange("熟悉狀態未儲存。", storage => storage.markFamiliar(record.wordId))) {
        renderReview();
        reviewStatus.querySelector(":checked").focus();
      }
    });
    item.append(mark);
  }
  return item;
}

function updateReviewPractice(records) {
  const pending = records.filter(record => !record.familiar);
  const existing=pending.filter(record=>wordsById.get(record.wordId)?.unitId===record.unitId);
  const valid=existing.filter(record=>!wordsById.get(record.wordId)?.pendingVerbForms);
  const unitIds = new Set(pending.map(record => record.unitId));

  let note = "";
  if (unitIds.size > 1) note = "待複習單字分屬多個單元，請先選擇特定單元。";
  else if (existing.length !== pending.length) note = "部分待複習紀錄找不到題庫單字，無法開始本輪測驗。";

  if(!note&&existing.length&&!valid.length) note="待複習詞條的三態待補，目前無可出題詞條。";
  reviewStart.disabled = valid.length === 0 || Boolean(note);
  reviewQuizCount.textContent = `可測驗的待複習單字 ${numberFormat.format(valid.length)} 個`;
  reviewQuizNote.hidden = !note;
  reviewQuizNote.textContent = note;
  reviewQuizError.hidden = true;
  reviewQuizError.textContent = "";
  if (reviewStart.disabled) return null;
  return { unitId: valid[0].unitId, wordIds: valid.map(record => record.wordId) };
}

function renderReview() {
  const records = readMistakes(reviewUnit.value || undefined);
  reviewContent.hidden = records === null;
  if (records === null) return;

  const status = reviewStatus.querySelector(":checked").value;
  const familiarCount = records.filter(record => record.familiar).length;
  document.querySelector("#review-pending-count").textContent = numberFormat.format(records.length - familiarCount);
  document.querySelector("#review-familiar-count").textContent = numberFormat.format(familiarCount);

  const filtered = records.filter(record => status === "all" || record.familiar === (status === "familiar"));
  filtered.sort((a, b) => b.missCount - a.missCount || Date.parse(b.lastMissedAt) - Date.parse(a.lastMissedAt));
  reviewList.replaceChildren(...filtered.map(createReviewRow));
  reviewEmpty.hidden = filtered.length > 0;
  const emptyMessages = {
    pending: "目前沒有待複習的單字。",
    all: "目前沒有錯題紀錄。",
    familiar: "目前沒有已熟悉的單字。",
  };
  reviewEmpty.textContent = records.length === 0 ? emptyMessages.all : emptyMessages[status];
  return updateReviewPractice(records);
}

function showReview() {
  if (!photoScreen.hidden) return;
  if (!confirmLeaveRound() || !confirmLeaveEditor()) return;

  showScreen(reviewScreen);
  const practice = renderReview();
  window.scrollTo(0, 0);
  document.querySelector("#review-title").focus();
  return practice;
}

function startReviewQuiz() {
  if (round) return;

  const practice = reviewScreen.hidden ? showReview() : renderReview();
  if (practice) launchQuiz(practice.unitId, practice.wordIds);
}

function createUnitRow(unit, count, ready) {
  const item = document.createElement("li");
  const row = document.createElement("button");
  row.className = "unit-row";
  row.classList.toggle("is-empty", count === 0);
  row.type = "button";
  row.dataset.unitId = unit.id;
  row.addEventListener("click", () => {
    selectedUnitId = row.dataset.unitId;
    wordSearch.value = "";
    showUnitDetail();
  });

  const name = document.createElement("span");
  name.className = "unit-name";
  name.textContent = unit.name;

  const meta = document.createElement("span");
  meta.className = "unit-meta";
  const total = document.createElement("span");
  total.textContent = unitWordCounts(count, ready);
  meta.append(total);
  if (count === 0) {
    const status = document.createElement("span");
    status.textContent = "尚未匯入";
    meta.append(status);
  }

  row.append(name, meta);
  item.append(row);
  return item;
}

function renderHome(units, words) {
  const counts = new Map();
  const readyCounts = new Map();
  for (const unit of units) {
    if (typeof unit?.id !== "string" || !unit.id ||
        typeof unit.name !== "string" || !unit.name || counts.has(unit.id)) {
      throw new Error("單元資料格式有誤。");
    }
    counts.set(unit.id, 0);
    readyCounts.set(unit.id, 0);
  }
  for (const word of words) {
    if (!counts.has(word?.unitId)) {
      throw new Error("單字資料含有無法對應的單元。");
    }
    counts.set(word.unitId, counts.get(word.unitId) + 1);
  }

  for (const word of quizReadyWords(words)) {
    if (!unitQuizErrors.has(word.unitId)) readyCounts.set(word.unitId, readyCounts.get(word.unitId) + 1);
  }
  const groups = new Map();
  for (const unit of units) {
    const level = Number.isInteger(unit.level) ? `Level ${unit.level}` : "";
    const groupName = [unit.textbook, level].filter(Boolean).join(" · ") || "獨立分類";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(unit);
  }

  const groupContainer = document.querySelector("#unit-groups");
  groupContainer.replaceChildren();
  for (const [groupName, groupUnits] of groups) {
    const group = document.createElement("section");
    group.className = "unit-group";
    const heading = document.createElement("h3");
    heading.textContent = groupName;
    const list = document.createElement("ul");
    list.className = "unit-list";
    list.setAttribute("role", "list");

    for (const unit of groupUnits) {
      list.append(createUnitRow(unit, counts.get(unit.id), readyCounts.get(unit.id)));
    }
    group.append(heading, list);
    groupContainer.append(group);
  }

  const practiceCount = units.length - unitQuizErrors.size;
  document.querySelector("#word-total").textContent = numberFormat.format(words.length);
  document.querySelector("#quiz-word-total").textContent = numberFormat.format([...readyCounts.values()].reduce((sum, count) => sum + count, 0));
  document.querySelector("#unit-total").textContent = numberFormat.format(practiceCount);
  document.querySelector("#empty-bank").hidden = units.length > 0;
}

async function loadData(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    throw new Error(`無法連線讀取 ${path}。`);
  }
  if (!response.ok) {
    throw new Error(`無法讀取 ${path}（HTTP ${response.status}）。`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${path} 的 JSON 格式有誤。`);
  }
  return data;
}

function showBankStatus(message, isError = false) {
  bankStatus.hidden = !message;
  bankStatus.classList.toggle("is-error", isError);
  bankStatus.textContent = message;
}

function applyBank(bank) {
  unitQuizErrors.clear();
  for (const unit of bank.units) {
    try {
      createQuiz(quizReadyWords(bank.words), unit.id, { quizSettings: bank.quizSettings, random: () => 0.5 });
    } catch (error) {
      unitQuizErrors.set(unit.id, error.message);
    }
  }
  renderHome(bank.units, bank.words);
  activeBank = bank;
  unitNames.clear();
  wordsById.clear();
  const reviewFilter = reviewUnit.value;
  reviewUnit.replaceChildren(reviewUnit.options[0]);
  for (const unit of bank.units) {
    unitNames.set(unit.id, unit.name);
    const option = document.createElement("option");
    option.value = unit.id;
    option.textContent = unit.name;
    reviewUnit.append(option);
  }
  if (unitNames.has(reviewFilter)) reviewUnit.value = reviewFilter;
  for (const word of bank.words) wordsById.set(word.id, word);
}

function formSnapshot(form) {
  return JSON.stringify(Array.from(new FormData(form)));
}

function showFormError(form, message = "") {
  const error = form.querySelector(".management-error");
  error.textContent = message;
  error.hidden = !message;
}

function startEditor(screen, form, id) {
  editor = { form, id, initial: formSnapshot(form) };
  showFormError(form);
  showScreen(screen);
  window.scrollTo(0, 0);
  form.querySelector("h2").focus();
}

function finishEditor() {
  window.removeEventListener("beforeunload", warnOnUnload);
  clearDuplicate();
  editor = null;
}

function confirmLeaveEditor() {
  if (!editor) return true;
  if (formSnapshot(editor.form) !== editor.initial && !window.confirm("表單尚未儲存，要放棄變更嗎？")) {
    return false;
  }
  finishEditor();
  return true;
}

function cancelEditor() {
  const destination = editor?.form;
  if (!destination || !confirmLeaveEditor()) return;
  if (destination === wordForm) showWordManager();
  else if (selectedUnitId !== null) showUnitDetail();
  else showHome();
}

function openUnitEditor(unitId = null) {
  const unit = activeBank.units.find(record => record.id === unitId);
  unitForm.reset();
  for (const field of ["name", "textbook", "level", "unitNumber"]) {
    unitForm.elements[field].value = unit?.[field] ?? "";
  }
  document.querySelector("#unit-editor-title").textContent = unit ? "編輯單元" : "新增單元";
  startEditor(unitEditor, unitForm, unitId);
}

function saveUnit(event) {
  event.preventDefault();
  const { id } = editor;
  const fields = unitForm.elements;
  const draft = {
    name: fields.name.value.trim(),
    textbook: fields.textbook.value.trim() || null,
    level: fields.level.value === "" ? null : fields.level.valueAsNumber,
    unitNumber: fields.unitNumber.value === "" ? null : fields.unitNumber.valueAsNumber,
  };
  try {
    const storage = createBankStorage();
    const saved = id === null ? storage.addUnit(activeBank, draft) : storage.updateUnit(activeBank, id, draft);
    selectedUnitId = id ?? saved.units[saved.units.length - 1].id;
    wordSearch.value = "";
    applyBank(saved);
    finishEditor();
    showUnitDetail();
  } catch (error) {
    showFormError(unitForm, error.message);
  }
}

function describeWord(word) {
  return `${word.english}（${word.partOfSpeech}） ${word.chineseMeanings.join("、")}`;
}

function renderManagedWords() {
  const words = selectedUnitWords();
  const query = wordSearch.value.trim().toLowerCase();
  const matches = words.filter(word => word.english.toLowerCase().includes(query) ||
    word.chineseMeanings.some(meaning => meaning.toLowerCase().includes(query)));
  const list = document.querySelector("#managed-words");
  list.replaceChildren();
  for (const word of matches) {
    const item = document.createElement("li");
    item.className = "managed-word";
    const description = document.createElement("div");
    const english = document.createElement("strong");
    english.lang = "en";
    english.textContent = word.english;
    const part = document.createElement("p");
    part.className = "management-note";
    part.textContent = word.partOfSpeech+(word.pendingVerbForms?" · 三態待補":"");
    const meaning = document.createElement("p");
    meaning.textContent = word.chineseMeanings.join("、");
    description.append(english, part, meaning);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "quiz-button";
    edit.textContent = "編輯";
    edit.setAttribute("aria-label", `編輯 ${word.english}`);
    edit.addEventListener("click", () => openWordEditor(word.id));
    item.append(description, edit);
    list.append(item);
  }
  const empty = document.querySelector("#word-list-empty");
  empty.textContent = words.length ? "找不到符合的單字。" : "這個單元還沒有單字。";
  empty.hidden = matches.length > 0;
}

function showWordManager() {
  document.querySelector("#word-manager-unit").textContent =
    `${unitNames.get(selectedUnitId)} · ${formatWordCount(selectedUnitWords().length)}`;
  renderManagedWords();
  showScreen(wordManager);
  window.scrollTo(0, 0);
  document.querySelector("#word-manager-title").focus();
}

function addCheckbox(container, name, value, text, checked) {
  const label = document.createElement("label");
  label.className = "word-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const caption = document.createElement("span");
  caption.textContent = text;
  label.append(input, caption);
  container.append(label);
}

function wordMeanings(data) {
  return String(data.get("meanings")).split(/\r?\n/).map(meaning => meaning.trim()).filter(Boolean);
}

function editedSenses(data, word) {
  if (!word?.senses?.length) return null;
  const meanings=data.getAll("linkedMeaning"), parts=data.getAll("linkedPart");
  return word.senses.map((sense,index)=>({...sense,meaning:meanings[index].trim(),partOfSpeech:parts[index]}));
}

function renderWordSenses(word) {
  const panel=document.querySelector("#word-senses"), rows=document.querySelector("#word-sense-rows");
  panel.hidden=!word?.senses?.length;
  panel.open=false;
  rows.replaceChildren(...(word?.senses??[]).map(sense=>{
    const row=document.createElement("div");
    row.className="field-columns";
    const meaning=document.createElement("input"), part=document.createElement("select");
    meaning.name="linkedMeaning";meaning.required=true;meaning.value=sense.meaning;
    part.name="linkedPart";
    for (const value of formParts) part.add(new Option(value,value));
    part.value=sense.partOfSpeech;
    for (const [label,control] of [["詞性 ",part],["詞義 ",meaning]]) {
      const wrapper=document.createElement("label");
      wrapper.append(label,control);row.append(wrapper);
    }
    return row;
  }));
}

function draftLexicalFields(data, word) {
  const senses=editedSenses(data,word);
  return {
    senses,
    parts:[...new Set([...data.getAll("part"),...senses?.map(sense=>sense.partOfSpeech)??[]])],
    meanings:[...new Set([...wordMeanings(data),...senses?.map(sense=>sense.meaning).filter(Boolean)??[]])],
  };
}

function updateQuizChoices() {
  const data = new FormData(wordForm);
  for (const [field, choices] of [
    ["quizPart", [...data.getAll("part"), ...data.getAll("linkedPart")]],
    ["quizMeaning", [...wordMeanings(data), ...data.getAll("linkedMeaning").map(value => value.trim()).filter(Boolean)]],
  ]) {
    const select = wordForm.elements[field];
    const previous = select.value;
    select.replaceChildren(new Option("請選擇", ""));
    for (const value of new Set(choices)) select.add(new Option(value, value));
    if (choices.includes(previous)) select.value = previous;
  }
}

function openWordEditor(wordId = null) {
  const word = wordsById.get(wordId);
  const settings = activeBank.quizSettings;
  const setting = Object.hasOwn(settings.wordSettings, wordId) ? settings.wordSettings[wordId] : null;
  const originalParts = word?.partOfSpeech.trim().split(/\s*&\s*/) ?? [];
  const forms = word?.verbForms ?? setting?.supplementalVerbForms;
  const fields = wordForm.elements;
  wordForm.reset();
  fields.english.value = word?.english ?? "";
  const linked=new Set(word?.senses?.map(sense=>sense.meaning));
  fields.meanings.value=word?.chineseMeanings.filter(meaning=>!linked.has(meaning)).join("\n")??"";
  fields.meanings.required=!word?.senses?.length;
  renderWordSenses(word);
  fields.material.value = word?.source.material ?? "";
  fields.page.value = word?.source.page ?? "";
  fields.verification.value = word?.verificationStatus ?? "unverified";
  for (const name of ["base", "past", "pastParticiple"]) fields[name].value = forms?.[name] ?? "";
  fields.formsSource.value = word?.verbForms ? "original" : "supplemental";

  const parts = document.querySelector("#word-parts");
  parts.replaceChildren();
  for (const part of new Set([...originalParts, ...formParts])) {
    addCheckbox(parts, "part", part, part, originalParts.includes(part));
  }
  const exclusions = document.querySelector("#word-exclusions");
  exclusions.replaceChildren();
  const excluded = new Set(settings.excludedPairs.filter(pair => pair.includes(wordId)).flat());
  for (const other of selectedUnitWords()) {
    if (other.id === wordId) continue;
    addCheckbox(exclusions, "exclude", other.id, describeWord(other), excluded.has(other.id));
  }
  if (!exclusions.childElementCount) exclusions.textContent = "同單元尚無其他單字。";
  updateQuizChoices(word);
  fields.quizPart.value = setting?.sense?.partOfSpeech ?? "";
  fields.quizMeaning.value = setting?.sense?.meaning ?? "";
  wordAdvanced.open = false;
  document.querySelector("#word-editor-title").textContent = word ? "編輯單字" : "新增單字";
  startEditor(wordEditor, wordForm, wordId);
}

function buildWordDraft(isEditing) {
  const data = new FormData(wordForm);
  const value = field => String(data.get(field) ?? "").trim();
  const {parts,meanings,senses}=draftLexicalFields(data,wordsById.get(editor?.id));
  const partOfSpeech = value("quizPart");
  const meaning = value("quizMeaning");
  const forms = { base: value("base"), past: value("past"), pastParticiple: value("pastParticiple") };
  const hasForms = Object.values(forms).some(Boolean);
  const word = {
    english: value("english"), chineseMeanings: meanings, partOfSpeech: parts.join(" & "),
    ...(senses?{senses}:{}),
    source: { material: value("material"), page: value("page") || null },
    verificationStatus: value("verification"),
  };
  if (!word.english || !word.chineseMeanings.length || !word.source.material) {
    throw new Error("請填寫英文單字、中文意思及教材來源。");
  }
  if (!parts.length) throw new Error("請至少勾選一個詞性。");
  if (word.verificationStatus === "verified" && !word.source.page) {
    throw new Error("標記為已核對時，請填寫教材頁碼。");
  }
  const quizSettings = {};
  const hasSense = Boolean(partOfSpeech && meaning);
  const missingSense = (parts.length > 1 || partOfSpeech || meaning) && !hasSense;
  const pending=Boolean(wordsById.get(editor?.id)?.pendingVerbForms)&&!isBaseOnlyVerb(word.english)&&!hasForms&&verbParts.has(partOfSpeech||parts[0]);
  if(isEditing&&wordsById.get(editor?.id)?.pendingVerbForms) word.pendingVerbForms=pending?true:null;
  const needsForms = hasForms || (!pending && !isBaseOnlyVerb(word.english) && verbParts.has(partOfSpeech || parts[0]));
  if (missingSense || (needsForms && !Object.values(forms).every(Boolean))) {
    wordAdvanced.open = true;
    throw new Error(missingSense ? "請完整選擇出題詞性與對應的中文意思。" :
      "請完整填寫動詞原形、過去式和過去分詞。");
  }
  if (hasForms && (forms.base !== word.english || !parts.some(part => verbParts.has(part)))) {
    wordAdvanced.open = true;
    throw new Error("動詞原形須與英文單字完全相同，並勾選至少一個動詞詞性。");
  }
  if (hasSense && senses && senses.some(sense=>sense.meaning===meaning) &&
      !senses.some(sense=>sense.meaning===meaning&&sense.partOfSpeech===partOfSpeech)) {
    throw new Error("出題詞性與逐義詞性不符，請重新選擇。");
  }
  if (hasSense) quizSettings.sense = { partOfSpeech, meaning };
  else if (isEditing) quizSettings.sense = null;
  if (hasForms && value("formsSource") === "original") word.verbForms = forms;
  else if (isEditing) word.verbForms = null;
  if (hasForms && value("formsSource") === "supplemental") quizSettings.supplementalVerbForms = forms;
  else if (isEditing) quizSettings.supplementalVerbForms = null;
  if (!isEditing) word.unitId = selectedUnitId;
  return { word, quizSettings, excludedWordIds: data.getAll("exclude") };
}

function clearDuplicate() {
  duplicateDraft = null;
  wordDuplicate.hidden = true;
}

function saveWord(confirmed = null) {
  const { id } = editor;
  let draft;
  showFormError(wordForm);
  clearDuplicate();
  try {
    draft = buildWordDraft(id !== null);
    const storage = createBankStorage();
    if (confirmed) {
      const current = (storage.read() ?? activeBank).words.find(word => word.id === confirmed.word.id);
      if (JSON.stringify(current) !== JSON.stringify(confirmed.word)) {
        throw new Error("原有詞條已更新，請重新按下儲存並核對內容。");
      }
      draft.mergeIntoWordId = confirmed.word.id;
      draft.excludedWordIds = draft.excludedWordIds.filter(other => other !== confirmed.word.id);
    }
    const saved = id === null ? storage.addWord(activeBank, draft) : storage.updateWord(activeBank, id, draft);
    applyBank(saved);
    finishEditor();
    wordSearch.value = "";
    showWordManager();
  } catch (error) {
    if (error instanceof DuplicateWordError && error.canMerge && !confirmed) {
      try {
        const bank = createBankStorage().read() ?? activeBank;
        const word = bank.words.find(record => record.id === error.existingWordId);
        if (word) {
          duplicateDraft = { word };
          document.querySelector("#duplicate-existing").textContent = describeWord(word);
          document.querySelector("#duplicate-incoming").textContent = describeWord(draft.word);
          wordDuplicate.hidden = false;
          document.querySelector("#duplicate-title").focus();
          return;
        }
      } catch (readError) {
        showFormError(wordForm, readError.message);
        return;
      }
    }
    showFormError(wordForm, error.message);
  }
}

async function loadDefaultBank() {
  const [units, words, quizSettings] = await Promise.all([
    loadData("data/units.json"),
    loadData("data/words.json"),
    loadData("data/quiz-settings.json"),
  ]);
  return validateBank({ schemaVersion: BANK_SCHEMA_VERSION, units, words, quizSettings });
}

async function start() {
  let savedBank;
  try {
    savedBank = createBankStorage().read();
  } catch (error) {
    showBankStatus(`${error.message} 目前使用預設題庫。`, true);
  }
  try {
    applyBank(savedBank ?? await loadDefaultBank());
    loadStatus.hidden = true;
    home.hidden = false;
    reviewTab.disabled = false;
    readMistakes();
  } catch (error) {
    loadStatus.classList.add("notice-error");
    loadStatus.textContent = `載入單字資料失敗。 ${error.message}`;
  }
}

function dismissBankPreview() {
  pendingBank = null;
  bankPreview.hidden = true;
}

async function previewBankImport() {
  const [file] = bankFile.files;
  bankFile.value = "";
  if (!file) return;

  const sequence = ++bankReadSequence;
  dismissBankPreview();
  showBankStatus("正在核對題庫…");
  try {
    const bank = parseBank(await file.text());
    if (sequence !== bankReadSequence) return;
    mergeBanks(activeBank, bank);
    pendingBank = bank;
    const units = numberFormat.format(bank.units.length);
    const words = numberFormat.format(bank.words.length);
    bankPreviewSummary.textContent = `此檔案包含 ${units} 個單元、${words} 個單字。`;
    showBankStatus("");
    bankPreview.hidden = false;
    bankPreviewSummary.focus();
  } catch (error) {
    if (sequence === bankReadSequence) showBankStatus(`無法匯入。 ${error.message}`, true);
  }
}

function confirmBankImport() {
  if (!pendingBank || round || home.hidden) return;
  try {
    applyBank(createBankStorage().importBank(activeBank, pendingBank));
    dismissBankPreview();
    const units = numberFormat.format(activeBank.units.length);
    const words = numberFormat.format(activeBank.words.length);
    showBankStatus(`匯入完成，目前有 ${units} 個單元、${words} 個單字。`);
    chooseBank.focus();
  } catch (error) {
    showBankStatus(`無法匯入。 ${error.message}`, true);
  }
}

function downloadPrivateJSON(value,filename) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = url;
  download.download = filename;
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function exportBank() {
  if (activeBank) downloadPrivateJSON(activeBank,"GSAT-Vocabulary-private.json");
}

function backupLearning() {
  try {
    const study=createStudyStorage();
    const bank=createBankStorage().read()??activeBank;
    if(!bank) return;
    const history={mistakes:study.getMistakes(),quizResults:study.getQuizResults()};
    downloadPrivateJSON({schemaVersion:1,appVersion:"0.8.6",createdAt:new Date().toISOString(),
      localStorage:{[BANK_STORAGE_KEY]:bank,[STORAGE_KEY]:history}},"GSAT-Vocabulary-backup.json");
  } catch(error) {showBankStatus("備份失敗。"+error.message,true);}
}
document.querySelector("#backup-learning").addEventListener("click",backupLearning);

function waitForOfflineWorker(worker) {
  if (!worker) return Promise.reject(new Error("Service Worker 未安裝。"));

  return new Promise((resolve, reject) => {
    function checkState() {
      if (worker.state === "activated" || worker.state === "redundant") {
        worker.removeEventListener("statechange", checkState);
        if (worker.state === "activated") resolve();
        else reject(new Error("Service Worker 安裝失敗。"));
      }
    }
    worker.addEventListener("statechange", checkState);
    checkState();
  });
}

async function hasOfflineCache(worker) {
  const channel = new MessageChannel();
  let timeout;
  try {
    return await new Promise(resolve => {
      timeout = window.setTimeout(() => resolve(false), 5000);
      channel.port1.onmessage = event => resolve(event.data?.ready === true);
      worker.postMessage({ type: "GSAT_CHECK_OFFLINE" }, [channel.port2]);
    });
  } finally {
    window.clearTimeout(timeout);
    channel.port1.close();
  }
}

async function prepareOffline() {
  const status = document.querySelector("#offline-status");
  status.hidden = false;
  const unavailable = "目前網址無法啟用離線功能。請使用 HTTPS 或 localhost。";
  if (!window.isSecureContext) {
    status.textContent = unavailable;
    return;
  }

  status.textContent = "正在準備離線使用…";
  try {
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) {
      status.textContent = unavailable;
      return;
    }
    const scope = new URL("./", location.href).href;
    const existing = await serviceWorker.getRegistration(scope);
    const registration = existing?.scope === scope && existing.active
      ? existing
      : await serviceWorker.register("./sw.js", { updateViaCache: "none" });
    const worker = registration.active ?? registration.installing ?? registration.waiting;
    await waitForOfflineWorker(worker);
    if (!await hasOfflineCache(worker)) throw new Error("離線資源不完整。");
    status.textContent = "可離線使用";
    status.classList.add("is-ready");
  } catch {
    status.textContent = "離線快取未就緒，仍可連網使用。";
  }
}

async function openPhotoImport() {
  if (!activeBank || home.hidden || round) return;
  const trigger=document.querySelector("#open-photo-import");
  trigger.disabled=true;
  try {
    const {mountPhotoImport}=await import("./photo-import-ui.js");
    if (home.hidden || round) return;
    photoSession??=mountPhotoImport({
      readBank:()=>activeBank,
      readLatest:()=>createBankStorage().read()??activeBank,
      commit:preview=>createBankStorage().commitBatch(activeBank,preview.expected,preview.bank),
      close(){
        photoSession.reset();
        window.removeEventListener("beforeunload",warnOnUnload);
        showScreen(home);trigger.focus();
      },
      done(bank,id,summary){
        applyBank(bank);readMistakes();
        showBankStatus("拍照匯入完成，新增 "+summary.added+" 筆，更新 "+summary.updated+" 筆。");
        const target=document.querySelector("#photo-target");
        if(!Array.from(target.options).some(option=>option.value===id)) target.add(new Option(unitNames.get(id),id));
        target.value=id;
        document.querySelector("#photo-new-unit").hidden=true;
      },
    });
    showScreen(photoScreen);
    window.addEventListener("beforeunload",warnOnUnload);
    photoSession.open();
    window.scrollTo(0,0);
    document.querySelector("#photo-title").focus();
  } catch(error) {
    if (!photoScreen.hidden) {
      window.removeEventListener("beforeunload",warnOnUnload);showScreen(home);
    }
    showBankStatus(error.message,true);
  } finally {trigger.disabled=false;}
}

async function checkAppUpdate() {
  if (round||!photoScreen.hidden||editor) return;
  const button=document.querySelector("#check-update"), status=document.querySelector("#update-status");
  button.disabled=true;
  status.textContent="正在檢查更新…";
  try {
    const registration=await navigator.serviceWorker?.getRegistration();
    if (!registration) throw new Error("目前無法檢查更新，請使用 HTTPS 或 localhost。");
    await registration.update();
    status.textContent=registration.waiting||registration.installing?
      "新版正在準備。完成目前操作後，關閉此 App 的所有視窗再開啟。":"目前沒有待套用的更新。";
  } catch(error) {status.textContent=error.message;}
  finally {button.disabled=false;}
}
document.querySelector("#open-photo-import").addEventListener("click",()=>void openPhotoImport());
document.querySelector("#check-update").addEventListener("click",()=>void checkAppUpdate());
document.querySelector("#back-button").addEventListener("click", showHome);
document.querySelector("#add-unit").addEventListener("click", () => openUnitEditor());
document.querySelector("#edit-unit").addEventListener("click", () => openUnitEditor(selectedUnitId));
document.querySelector("#manage-words").addEventListener("click", showWordManager);
document.querySelector("#back-from-words").addEventListener("click", showUnitDetail);
document.querySelector("#add-word").addEventListener("click", () => openWordEditor());
wordSearch.addEventListener("input", renderManagedWords);
for (const button of document.querySelectorAll("[data-cancel-editor]")) {
  button.addEventListener("click", cancelEditor);
}
for (const form of [unitForm, wordForm]) {
  form.addEventListener("input", event => {
    if (form === wordForm) {
      if (["part","meanings","linkedPart","linkedMeaning"].includes(event.target.name)) updateQuizChoices();
      clearDuplicate();
    }
    if (formSnapshot(form) === editor.initial) window.removeEventListener("beforeunload", warnOnUnload);
    else window.addEventListener("beforeunload", warnOnUnload);
  });
}
unitForm.addEventListener("submit", saveUnit);
wordForm.addEventListener("submit", event => {
  event.preventDefault();
  saveWord();
});
document.querySelector("#confirm-word-merge").addEventListener("click", () => {
  if (duplicateDraft) saveWord(duplicateDraft);
});
document.querySelector("#cancel-word-merge").addEventListener("click", () => {
  clearDuplicate();
  wordForm.querySelector('[type="submit"]').focus();
});
chooseBank.addEventListener("click", () => bankFile.click());
bankFile.addEventListener("change", previewBankImport);
document.querySelector("#confirm-bank").addEventListener("click", confirmBankImport);
document.querySelector("#cancel-bank").addEventListener("click", () => {
  dismissBankPreview();
  chooseBank.focus();
});
document.querySelector("#export-bank").addEventListener("click", exportBank);
unitsTab.addEventListener("click", showHome);
reviewTab.addEventListener("click", showReview);
reviewUnit.addEventListener("change", renderReview);
reviewStatus.addEventListener("change", renderReview);
reviewStart.addEventListener("click", startReviewQuiz);
document.querySelector("#start-quiz").addEventListener("click", startQuiz);
document.querySelector("#retry-quiz").addEventListener("click", () => {
  if (lastResultWasReview) startReviewQuiz();
  else startQuiz();
});
resultBack.addEventListener("click", () => {
  if (lastResultWasReview) showReview();
  else showHome();
});
document.querySelector("#leave-quiz").addEventListener("click", () => {
  if (round?.isReview) showReview();
  else if (confirmLeaveRound()) showUnitDetail();
});
nextButton.addEventListener("click", () => {
  if (round?.answer === "wrong") advanceQuestion();
});
window.addEventListener("pagehide", () => {
  if (!round) return;
  const { isReview } = round;
  discardRound();
  if (isReview) {
    showScreen(reviewScreen);
    renderReview();
  } else {
    showUnitDetail();
  }
});
start();
prepareOffline();
