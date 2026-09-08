import assert from "node:assert/strict";
import test from "node:test";
import { localVoice, MessageSpeech } from "../apps/web/src/speechController.ts";
import { speechChunks, speechText } from "../apps/web/src/speechText.ts";

const voices = [
  { lang: "ru-RU", default: true, localService: false, name: "Remote" },
  { lang: "en-US", default: true, localService: true, name: "English" },
  { lang: "ru-RU", default: false, localService: true, name: "Russian" },
];
function fixture(available = voices) {
  const calls = [],
    utterances = [];
  const engine = {
    getVoices: () => available,
    speak(u) {
      utterances.push(u);
      calls.push("speak");
    },
    cancel() {
      calls.push("cancel");
    },
    pause() {
      calls.push("pause");
    },
    resume() {
      calls.push("resume");
    },
  };
  const player = new MessageSpeech(() => ({ engine, utterance: (text) => ({ text }) }));
  return { calls, utterances, player };
}
test("speech extracts public Markdown prose, without code blocks, images, HTML or link destinations", () => {
  const text = speechText(
    "# Заголовок\n\n**Привет** [ссылка](https://private.test/token). `кнопка`\n\n```js\nсекретный код\n```\n\n![подпись](https://image.test/x)\n\n- Первый\n- Второй\n\n<div>не читаем HTML</div>\n\nhttps://example.test/signed",
  );
  assert.match(text, /Заголовок\n\nПривет ссылка\. кнопка/);
  assert.match(text, /Первый\n\nВторой/);
  assert.doesNotMatch(text, /private|token|секретный|подпись|HTML|example|signed|\*\*/);
  assert.equal(speechText("```text\nonly code\n```"), "");
});
test("long prose chunks preserve words and paragraph order with bounded, Unicode-safe utterances", () => {
  const text =
    "Первый абзац. Ещё фраза!\n\n" +
    "Длинное предложение ".repeat(600) +
    "Конец.\n\n" +
    "🙂".repeat(380);
  const chunks = speechChunks(text);
  assert(chunks.length > 30);
  assert(chunks.every((c) => c.length <= 360 && c.isWellFormed()));
  assert.equal(chunks.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});
test("voice selection only permits local voices and favors the message language", () => {
  assert.equal(localVoice(voices, "Привет мир", "en-US").name, "Russian");
  assert.equal(localVoice(voices, "Hello world", "ru-RU").name, "English");
  assert.equal(localVoice([voices[0]], "Привет", "ru"), undefined);
});
test("single writer ignores rapid duplicate starts and late terminal callbacks from canceled speech", () => {
  const f = fixture();
  f.player.start("c:1", ["Первый", "Продолжение"], "ru");
  const old = f.utterances[0];
  f.player.start("c:1", ["Первый"], "ru");
  assert.equal(f.utterances.length, 1);
  f.player.start("c:2", ["Второй", "Ещё"], "ru");
  old.onend();
  old.onerror();
  assert.equal(f.utterances.length, 2);
  assert.equal(f.player.snapshot().id, "c:2");
  f.utterances[1].onend();
  assert.equal(f.utterances[2].text, "Ещё");
  f.utterances[2].onend();
  assert.equal(f.player.snapshot().phase, "idle");
});
test("pause/resume keeps the same native utterance and never replays its text", () => {
  const f = fixture();
  f.player.start("c:1", ["Первый", "Второй"], "ru");
  const u = f.utterances[0];
  f.player.pause();
  f.player.pause();
  assert.equal(f.player.snapshot().phase, "paused");
  f.player.resume();
  f.player.resume();
  assert.equal(f.utterances.length, 1);
  assert.equal(f.calls.filter((x) => x === "pause").length, 1);
  u.onend();
  assert.equal(f.utterances[1].text, "Второй");
});
test("a pause at a chunk boundary waits for an explicit resume before the next chunk", () => {
  const f = fixture();
  f.player.start("c:1", ["Первый", "Второй"], "ru");
  f.player.pause();
  f.utterances[0].onend();
  assert.equal(f.utterances.length, 1);
  assert.equal(f.player.snapshot().phase, "paused");
  f.player.resume();
  assert.equal(f.utterances[1].text, "Второй");
  f.player.stop();
  f.utterances[1].onend();
  assert.equal(f.utterances.length, 2);
});
test("scope cleanup stops only its own message and never replays after an error", () => {
  const f = fixture();
  f.player.start("gpt:chat:1", ["Первый", "Второй"], "ru");
  f.player.stopScope("codex:chat");
  assert.equal(f.player.snapshot().phase, "speaking");
  f.utterances[0].onerror();
  assert.equal(f.player.snapshot().phase, "idle");
  assert(f.player.snapshot().error);
  assert.equal(f.utterances.length, 1);
  f.player.start("gpt:chat:1", ["Сначала"], "ru");
  assert.equal(f.utterances.length, 2);
  f.player.stopScope("gpt:chat");
  assert.equal(f.player.snapshot().id, null);
});
test("no local voice means no spoken text leaves the page, and voices can become available later", () => {
  const available = [],
    f = fixture(available);
  f.player.start("c:1", ["Личный ответ"], "ru");
  assert.equal(f.utterances.length, 0);
  assert(f.player.snapshot().error);
  available.push(voices[2]);
  f.player.start("c:1", ["Личный ответ"], "ru");
  assert.equal(f.utterances[0].voice.localService, true);
});
