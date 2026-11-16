const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

async function loadPlugin(saved, tasksStatuses = null) {
  const settings = [];
  const notices = [];
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [2026, 0, 1, 12]));
    }
  }
  const context = {
    Date: FixedDate,
    module: { exports: {} },
    require: () => ({
      Plugin: class {
        async loadData() { return saved; }
        async saveData(data) { this.saved = { ...data }; }
        addSettingTab(tab) { this.settingTab = tab; }
        addCommand() {}
      },
      PluginSettingTab: class { constructor() { this.containerEl = { empty() {} }; } },
      Setting: class {
        constructor() { settings.push(this); }
        setName(name) { this.name = name; return this; }
        setHeading() { return this; }
        setDesc() { return this; }
        addText(callback) { return this.addControl(callback); }
        addToggle(callback) { return this.addControl(callback); }
        addDropdown(callback) { return this.addControl(callback); }
        addControl(callback) {
          this.control = {
            addOption() { return this; },
            setPlaceholder() { return this; },
            setValue(value) { this.value = value; return this; },
            onChange(handler) { this.change = handler; return this; },
          };
          callback(this.control);
          return this;
        }
      },
      Notice: class { constructor(message) { notices.push(message); } },
    }),
  };
  vm.runInNewContext(source, context, { filename: "main.js" });
  const plugin = new context.module.exports();
  plugin.app = {
    plugins: { manifests: tasksStatuses ? { "obsidian-tasks-plugin": { dir: "tasks" } } : {} },
    vault: {
      adapter: {
        exists: async () => true,
        read: async () => JSON.stringify({ statusSettings: { customStatuses: tasksStatuses } }),
      },
    },
  };
  plugin.settingControls = settings;
  plugin.notices = notices;
  await plugin.onload();
  return plugin;
}

async function sort(plugin, lines, mode = "due-date") {
  let value = lines.join("\n");
  await plugin.sortTasks({
    getValue: () => value,
    getCursor: () => ({ line: 0, ch: 0 }),
    listSelections: () => [],
    transaction: ({ changes }) => { value = changes[0].text; },
    setCursor: () => {},
  }, mode);
  return value.split("\n");
}

test("tasks with any status symbol keep their dates", async () => {
  const plugin = await loadPlugin(null);
  const input = ["- [ ] Later 📅 2026-03-01", "- [/] In progress 📅 2026-02-01", "- [!] Important 📅 2026-01-15"];
  assert.deepEqual(await sort(plugin, input), [input[2], input[1], input[0]]);
});

test("date emoji aliases and variation selectors are read", async () => {
  const plugin = await loadPlugin(null);
  const input = [
    "- [ ] Plain 📅 2026-06-01",
    "- [ ] Selector 📅️ 2026-05-01",
    "- [ ] Calendar 📆 2026-04-01",
    "- [ ] Spiral 🗓️ 2026-03-01",
    "- [ ] Hourglass ⌛ 2026-02-01",
    "- [ ] Scheduled selector ⏳️ 2026-01-15",
    "- [x] Done older ✅️ 2025-01-01",
    "- [x] Done newer ✅ 2025-06-01",
  ];
  assert.deepEqual(await sort(plugin, input),
    [input[5], input[4], input[3], input[2], input[1], input[0], input[7], input[6]]);
});

test("Tasks status types override defaults, including custom done symbols", async () => {
  const plugin = await loadPlugin(null, [
    { symbol: "d", type: "DONE" },
    { symbol: "-", type: "TODO" },
  ]);
  const input = ["- [d] Custom done ✅ 2026-01-01", "- [-] Now a todo", "- [x] Done ✅ 2025-12-01"];
  assert.deepEqual(await sort(plugin, input, "completed"), [input[1], input[0], input[2]]);
});

test("priority breaks ties between equal dates only", async () => {
  const plugin = await loadPlugin(null);
  const input = [
    "- [ ] Undated low 🔽",
    "- [ ] Undated highest 🔺",
    "- [ ] Lowest ⏬ 📅 2026-02-01",
    "- [ ] Normal 📅 2026-02-01",
    "- [ ] Low 🔽 📅 2026-02-01",
    "- [ ] Medium 🔼 📅 2026-02-01",
    "- [ ] High ⏫ 📅 2026-02-01",
    "- [ ] Highest 🔺 📅 2026-02-01",
    "- [ ] Earlier lowest ⏬ 📅 2026-01-01",
  ];
  assert.deepEqual(await sort(plugin, input),
    [input[8], input[7], input[6], input[5], input[3], input[4], input[2], input[0], input[1]]);
});

test("earliest sort date uses start, scheduled or due and respects the range", async () => {
  const plugin = await loadPlugin({ sortDate: "earliest", sortableDateRangeDays: 60 });
  const input = [
    "- [ ] Due first 📅 2026-01-20 ⏳ 2026-02-01",
    "- [ ] Starts soon 📅 2026-02-20 🛫 2026-01-05",
    "- [ ] Scheduled before due 📅 2026-01-25 ⏳ 2026-01-10",
    "- [ ] Start only, beyond range 🛫 2026-06-01",
  ];
  assert.deepEqual(await sort(plugin, input), [input[1], input[2], input[0], input[3]]);
  assert.match(plugin.notices.at(-1), /1 task skipped from date sorting/);

  plugin.settings.sortDate = "due";
  assert.deepEqual(await sort(plugin, input), [input[0], input[2], input[1], input[3]]);
});

test("in-progress first applies to both sort commands and Tasks IN_PROGRESS symbols", async () => {
  const plugin = await loadPlugin({ inProgressFirst: true }, [{ symbol: "w", type: "IN_PROGRESS" }]);
  const input = [
    "- [ ] Soon 📅 2026-01-02",
    "- [/] Started later 📅 2026-03-01",
    "- [x] Done",
    "- [w] Working undated",
    "- [/] Started sooner 📅 2026-02-01",
  ];
  assert.deepEqual(await sort(plugin, input), [input[4], input[1], input[3], input[0], input[2]]);
  assert.deepEqual(await sort(plugin, input, "completed"), [input[1], input[3], input[4], input[0], input[2]]);

  await sort(plugin, ["- [ ] Open", "- [/] Started"], "completed");
  assert.equal(plugin.notices.at(-1), "Moved in-progress tasks to the top.");
});

test("new settings default off, normalize and save", async () => {
  const plugin = await loadPlugin({ sortDate: "start", inProgressFirst: "yes" });
  assert.equal(plugin.settings.sortDate, "due");
  assert.equal(plugin.settings.inProgressFirst, false);
  plugin.settingTab.display();
  const control = (name) => plugin.settingControls.find((setting) => setting.name === name).control;
  await control("Sort date").change("earliest");
  await control("In-progress tasks first").change(true);
  assert.equal(plugin.saved.sortDate, "earliest");
  assert.equal(plugin.saved.inProgressFirst, true);
});
