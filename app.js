import { createQuiz } from "./quiz.js";
import { createStudyStorage } from "./storage.js";
import { BANK_SCHEMA_VERSION, createBankStorage, mergeBanks, parseBank, validateBank } from "./bank.js";

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
const questionMeaning = document.querySelector("#question-meaning");
const progressBar = document.querySelector("#quiz-progress-bar");
const optionList = document.querySelector("#quiz-options");
const feedback = document.querySelector("#quiz-feedback");
const nextButton = document.querySelector("#next-question");
const letters = ["A", "B", "C", "D"];
const unitNames = new Map();
const wordsById = new Map();
const writeWarnings = new Map();
let activeBank = null;
let pendingBank = null;
let bankReadSequence = 0;
let studyStorage;
let readWarning = "";
let selectedUnit = null;
let selectedButton = null;
let round = null;
let lastResultWasReview = false;

function formatWordCount(count) {
  return `${numberFormat.format(count)} 個單字`;
}

function showUnit(unit, count, button) {
  selectedUnit = unit;
  selectedButton = button;
  detailTitle.textContent = unit.name;
  detailCount.textContent = `收錄 ${formatWordCount(count)}`;
  showUnitDetail();
}

function showScreen(screen) {
  for (const view of [home, detail, quizScreen, resultScreen, reviewScreen]) {
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
  quizError.hidden = true;
  quizError.textContent = "";
  showScreen(detail);
  window.scrollTo(0, 0);
  detailTitle.focus();
}

function showHome() {
  if (!home.hidden || reviewTab.disabled || !confirmLeaveRound()) return;

  showScreen(home);
  (selectedButton ?? unitsTab).focus();
  selectedUnit = null;
  selectedButton = null;
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
  if (selectedUnit) launchQuiz(selectedUnit.id);
}

function launchQuiz(unitId, wordIds) {
  if (round) return;
  const isReview = wordIds !== undefined;

  let questions;
  try {
    questions = createQuiz(activeBank.words, unitId, { wordIds, quizSettings: activeBank.quizSettings });
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
  const valid = pending.filter(record => wordsById.get(record.wordId)?.unitId === record.unitId);
  const unitIds = new Set(pending.map(record => record.unitId));

  let note = "";
  if (unitIds.size > 1) note = "待複習單字分屬多個單元，請先選擇特定單元。";
  else if (valid.length !== pending.length) note = "部分待複習紀錄找不到題庫單字，無法開始本輪測驗。";

  reviewStart.disabled = valid.length === 0 || Boolean(note);
  reviewQuizCount.textContent = `可測驗的待複習單字 ${numberFormat.format(valid.length)} 個`;
  reviewQuizNote.hidden = !note;
  reviewQuizNote.textContent = note;
  reviewQuizError.hidden = true;
  reviewQuizError.textContent = "";
  if (reviewStart.disabled) return null;
  return { unitId: pending[0].unitId, wordIds: pending.map(record => record.wordId) };
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
  if (!confirmLeaveRound()) return;

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

function createUnitRow(unit, count) {
  const item = document.createElement("li");
  const row = document.createElement(count > 0 ? "button" : "div");
  row.className = "unit-row";
  if (count > 0) {
    row.type = "button";
    row.addEventListener("click", () => showUnit(unit, count, row));
  }

  const name = document.createElement("span");
  name.className = "unit-name";
  name.textContent = unit.name;

  const meta = document.createElement("span");
  meta.className = "unit-meta";
  const total = document.createElement("span");
  total.textContent = formatWordCount(count);
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
  for (const unit of units) {
    if (typeof unit?.id !== "string" || !unit.id ||
        typeof unit.name !== "string" || !unit.name || counts.has(unit.id)) {
      throw new Error("單元資料格式有誤。");
    }
    counts.set(unit.id, 0);
  }
  for (const word of words) {
    if (!counts.has(word?.unitId)) {
      throw new Error("單字資料含有無法對應的單元。");
    }
    counts.set(word.unitId, counts.get(word.unitId) + 1);
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
      list.append(createUnitRow(unit, counts.get(unit.id)));
    }
    group.append(heading, list);
    groupContainer.append(group);
  }

  const practiceCount = [...counts.values()].filter(count => count > 0).length;
  document.querySelector("#word-total").textContent = numberFormat.format(words.length);
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
  renderHome(bank.units, bank.words);
  activeBank = bank;
  unitNames.clear();
  wordsById.clear();
  reviewUnit.replaceChildren(reviewUnit.options[0]);
  for (const unit of bank.units) {
    unitNames.set(unit.id, unit.name);
    const option = document.createElement("option");
    option.value = unit.id;
    option.textContent = unit.name;
    reviewUnit.append(option);
  }
  for (const word of bank.words) wordsById.set(word.id, word);
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

function exportBank() {
  if (!activeBank) return;
  const blob = new Blob([JSON.stringify(activeBank, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const download = document.createElement("a");
  download.href = url;
  download.download = "GSAT-Vocabulary-private.json";
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

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

document.querySelector("#back-button").addEventListener("click", showHome);
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
    showScreen(detail);
  }
});
start();
prepareOffline();
