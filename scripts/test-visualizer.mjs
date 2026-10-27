import assert from "node:assert/strict";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { jiti, root } from "./test-helpers.mjs";

const { RecordingMeter } = await jiti.import(resolve(root, "src/visualizer.ts"));
const theme = { fg: (_color, text) => `\x1b[90m${text}\x1b[39m` };
let widget;
let updates = 0;
const ctx = {
  hasUI: true,
  mode: "tui",
  ui: {
    theme,
    setWidget(_key, content) {
      updates++;
      widget = content;
    },
  },
};

// Mirror Pi's string-array widget path with the real TUI components. Each
// array entry becomes a Text, whose render(width) wraps at the available
// width (including padding), independently of process.stdout.columns.
function previewComponent() {
  assert.ok(Array.isArray(widget));
  assert.equal(widget.length, 2, "meter and transcript remain separate widget entries");
  const container = new Container();
  container.addChild(new Text(widget[1], 1, 0));
  return container;
}
function plainRows(component, width) {
  const rows = component.render(width);
  assert.ok(rows.every((row) => visibleWidth(row) <= width), `rows must fit ${width} columns`);
  return rows.map((row) => stripVTControlCharacters(row).trim());
}
const compact = (text) => text.replace(/\s/g, "");

const meter = new RecordingMeter();
meter.start(ctx, "space to transcribe · escape to discard");
assert.equal(widget.length, 1, "no preview before the first partial");

const chinese = "我现在使用豆包流式转写，超过一行也应该完整显示，不要用省略号隐藏后面的内容。".repeat(8);
meter.setPartial(chinese);
const preview = previewComponent();
for (const width of [80, 20, 120, 12, 40, 80]) {
  const rows = plainRows(preview, width);
  assert.ok(rows.length > 1, "long Chinese transcripts must wrap");
  assert.equal(rows.join(""), chinese, `resizing to ${width} columns must preserve all text`);
}

// Even a transcript exceeding 2000 UTF-16 code units must keep its beginning
// and ending. Wide emoji and combining characters use terminal cell widths.
const longText = "开头不能丢失🙂" + "中文 English e\u0301 👩‍💻 testing。".repeat(150) + "结尾也必须显示✅";
meter.setPartial(longText);
assert.equal(stripVTControlCharacters(widget[1]), longText);
for (const width of [12, 33, 100]) {
  assert.equal(compact(plainRows(previewComponent(), width).join("")), compact(longText));
}

// Partial revisions must repaint even if no audio or meter state changes.
const beforeRevision = updates;
meter.setPartial("这是修正后的完整内容。");
assert.equal(updates, beforeRevision + 1);
assert.equal(plainRows(previewComponent(), 20).join(""), "这是修正后的完整内容。");
meter.update({ modelState: "ready", microphoneStopped: false });
assert.equal(plainRows(previewComponent(), 20).join(""), "这是修正后的完整内容。");

// Keep the existing protection against terminal controls from remote text.
meter.setPartial("正常\x1b[31m红字\x1b[0m\n换行\t制表\x07结束");
assert.equal(stripVTControlCharacters(widget[1]), "正常红字 换行 制表 结束");
assert.doesNotMatch(widget[1], /\x1b\[31m|\x07|\n|\t/);

meter.setPartial("");
assert.equal(widget.length, 1, "empty partial must remove the previous preview");
meter.stop();
assert.equal(widget, undefined, "stopping must clear the widget");
const afterStop = updates;
meter.setPartial("late update");
assert.equal(updates, afterStop, "late partials must not recreate a stopped widget");

console.log("PASS: streaming preview wraps Chinese, preserves long Unicode text, resizes, updates and clears safely");
