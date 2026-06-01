import { alignSyllabusSearch, compareVersusTarget } from "../server/syllabusMasterAlign.js";

const b4 = `Introduction to ReactJS
Introduction to ReactJS | Part 2
Components and Props
Components and Props | Part 2
Lists & Keys
State & Events
Conditional Rendering
State Hook | Part 2
State Hook | Part 2 | Delete Functionality
Effect Hook and Rules of Hooks
Effect Hooks - 2
Effect Hooks | Optimizing Performance
Making API Call with Hooks
Making API Call with Hooks | Part 2`;

const b2 = `Introduction to ReactJS
Introduction to ReactJS | Part 2
Components and Props
Components and Props | Part 2
Lists & Keys
State & Events
Conditional Rendering
State Hook | Part 2`;

const b3 = `Introduction to ReactJS
Introduction to ReactJS | Part 2
Components and Props
Components and Props | Part 2
Lists & Keys
State & Events
Conditional Rendering
State Hook | Part 2
State Hook | Part 2 | Delete Functionality
Effect Hook and Rules of Hooks
Effect Hook - 2
Effect Hooks | Optimizing Performance`;

console.log("B3 vs B4", compareVersusTarget(b4, b3));
console.log("B2 vs B4", compareVersusTarget(b4, b2));

const syllabusByKey = new Map([
  ["B4W10", b4],
  ["B3W10", b3],
  ["B2W10", b2],
]);

const result = alignSyllabusSearch({
  targetBatch: 4,
  targetWeek: 10,
  syllabusByKey,
  targetText: b4,
});

console.log("\nWinner:", result.winner?.key);
console.log(
  "Steps:",
  result.steps.map((s) => ({
    key: s.key,
    class: s.classification,
    extra: s.metrics?.extraUnits,
    cov: s.metrics?.lineRec,
  }))
);

if (result.winner?.key !== "B3W10") {
  console.error("FAIL: expected B3W10, got", result.winner?.key);
  process.exit(1);
}
if (result.winner?.week !== 10) {
  console.error("FAIL: winner must be same week W10, got W" + result.winner?.week);
  process.exit(1);
}
console.log("PASS: B3W10");

const targetW2 = "Unit A\nUnit B\nUnit C";
const b9w2 = "Unit A\nUnit B";
const b7w2 = "Unit A\nUnit B\nUnit C";

const fullScan = alignSyllabusSearch({
  targetBatch: 10,
  targetWeek: 2,
  syllabusByKey: new Map([
    ["B10W2", targetW2],
    ["B9W2", b9w2],
    ["B7W2", b7w2],
  ]),
  targetText: targetW2,
});

console.log("\nB10W2 full-scan winner:", fullScan.winner?.key, fullScan.winner?.matchType);
if (fullScan.winner?.key !== "B7W2" || fullScan.winner?.matchType !== "exact") {
  console.error("FAIL B10W2: expected exact B7W2");
  process.exit(1);
}
console.log("PASS: B7W2 exact (full scan beats B9W2)");

/* 100 target lines, candidate missing one → 99% line recall, not “exact” (needs ≥99.2%), but ≥98% reuse_config. */
const hundredLines = Array.from(
  { length: 100 },
  (_, i) => `Syllabus unit line ${String(i + 1).padStart(3, "0")} descriptive content here`
);
const target100 = hundredLines.join("\n");
const cand99 = hundredLines.slice(0, 99).join("\n");
const reuse98 = alignSyllabusSearch({
  targetBatch: 5,
  targetWeek: 3,
  syllabusByKey: new Map([
    ["B5W3", target100],
    ["B4W3", cand99],
  ]),
  targetText: target100,
});
console.log("\n98% subset tier (1 target line missing → not reuse_config):", reuse98.winner?.key, reuse98.winner?.matchType);
if (reuse98.winner?.key !== "B4W3" || reuse98.winner?.matchType !== "closest_subset") {
  console.error("FAIL: expected B4W3 closest_subset (reuse_config requires 0 missing target units)");
  process.exit(1);
}
console.log("PASS: high-coverage subset without reuse_config when target units are missing");

/* Target + two substantive extra lines in older batch (diluted lineExc with a longer shared syllabus). */
const base20 = Array.from(
  { length: 20 },
  (_, i) => `Unit ${String(i + 1).padStart(2, "0")} standard curriculum track content training module`
);
const tgt20 = base20.join("\n");
const candCaution = `${tgt20}
Unit supplementary elective track content training module advanced topics
Unit optional enrichment track content training module career preparation`;
const cautionRun = alignSyllabusSearch({
  targetBatch: 6,
  targetWeek: 1,
  syllabusByKey: new Map([
    ["B6W1", tgt20],
    ["B5W1", candCaution],
  ]),
  targetText: tgt20,
});
console.log("\nCaution tier:", cautionRun.winner?.key, cautionRun.winner?.matchType, cautionRun.winner?.caution);
if (cautionRun.winner?.key !== "B5W1" || cautionRun.winner?.matchType !== "reuse_caution") {
  console.error("FAIL reuse_caution: expected B5W1 reuse_caution, got", cautionRun.winner);
  process.exit(1);
}
console.log("PASS: reuse_caution with 2 extra units");

const tgtSup = `superset target line one module alpha content
superset target line two module beta content
superset target line three module gamma content`;
const candSup = `${tgtSup}
superset older batch extra unit four delta extended module content
superset older batch extra unit five epsilon extended module content`;
const supRun = alignSyllabusSearch({
  targetBatch: 10,
  targetWeek: 4,
  syllabusByKey: new Map([
    ["B10W4", tgtSup],
    ["B9W4", candSup],
    ["B8W4", tgtSup.split("\n").slice(0, 2).join("\n")],
  ]),
  targetText: tgtSup,
});
console.log("\nSuperset tier:", supRun.winner?.key, supRun.winner?.matchType);
if (supRun.winner?.key !== "B9W4" || supRun.winner?.matchType !== "reuse_superset") {
  console.error("FAIL reuse_superset: expected B9W4 reuse_superset, got", supRun.winner);
  process.exit(1);
}
console.log("PASS: reuse_superset when all target units present with extras");

/* B7 target: HTTP Part 1 only. B6 adds GenAI + Part 2 + tail forms; B3 adds Tailwind/GenAI sites + Part 2 — must pick B3 (fewer off-syllabus rows than B6 once Part 1≠Part 2). */
const b7w7mini = ["Introduction to JavaScript", "HTTP Requests using JS | Part 1"].join("\n");
const b6w7mini = [
  "Introduction to JavaScript",
  "Leveraging Gen AI for Accelerated learning",
  "HTTP Requests using JS | Part 2",
  "Forms extended module unit content here",
].join("\n");
const b3w7mini = [
  "Introduction to JavaScript",
  "Building Responsive Website using Tailwind CSS extended module unit",
  "Building a Responsive Website using GenAI extended module unit here",
  "HTTP Requests using JS | Part 1",
  "HTTP Requests using JS | Part 2",
].join("\n");
const b7pick = alignSyllabusSearch({
  targetBatch: 7,
  targetWeek: 7,
  syllabusByKey: new Map([
    ["B7W7", b7w7mini],
    ["B6W7", b6w7mini],
    ["B3W7", b3w7mini],
  ]),
  targetText: b7w7mini,
});
console.log("\nB7W7 mini winner:", b7pick.winner?.key, b7pick.winner?.matchType);
if (b7pick.winner?.key !== "B3W7") {
  console.error("FAIL B7W7: expected B3W7, got", b7pick.winner);
  process.exit(1);
}
console.log("PASS: B7W7 prefers B3W7 over B6W7 when Part 1/Part 2 are distinct");

/* B7W7 target: B6W7 superset (2 extras) vs B3W8 superset (1 extra) — cross-week scan must pick B3W8. */
const b7w7CrossT = Array.from(
  { length: 12 },
  (_, i) => `W7 unit ${String(i + 1).padStart(2, "0")} standard syllabus line content here`
).join("\n");
const b6w7Cross = `${b7w7CrossT}
extra line alpha supplementary unit content here longer text
extra line beta supplementary unit content here longer text`;
const b3w8Cross = `${b7w7CrossT}\nextra line single supplementary unit content here only one`;
const crossWeekPick = alignSyllabusSearch({
  targetBatch: 7,
  targetWeek: 7,
  syllabusByKey: new Map([
    ["B7W7", b7w7CrossT],
    ["B6W7", b6w7Cross],
    ["B3W8", b3w8Cross],
  ]),
  targetText: b7w7CrossT,
});
console.log("\nB7W7 cross-week superset winner:", crossWeekPick.winner?.key, crossWeekPick.winner?.matchType);
if (crossWeekPick.winner?.key !== "B3W8" || crossWeekPick.winner?.matchType !== "reuse_superset") {
  console.error("FAIL B7W7 cross-week: expected B3W8 reuse_superset, got", crossWeekPick.winner);
  process.exit(1);
}
console.log("PASS: B7W7 picks B3W8 (fewer extras) over B6W7 via cross-week scan");

/* B7W8: B2W8 has 98% + 0 extra but missing units — must not beat B3W8 (100% + 1 extra). */
const w8units = Array.from(
  { length: 24 },
  (_, i) => `Week eight unit ${String(i + 1).padStart(2, "0")} standard syllabus line content here`
);
const b7w8t = w8units.join("\n");
const b2w8c = w8units.slice(0, 22).join("\n");
const b3w8c = `${b7w8t}\nextra single supplementary unit line module content here only one`;
const b5w8c = `${b7w8t}\nextra alpha supplementary unit line module content here long\nextra beta supplementary unit line module content here long\nextra gamma supplementary unit line module content here long`;
const w8pick = alignSyllabusSearch({
  targetBatch: 7,
  targetWeek: 8,
  syllabusByKey: new Map([
    ["B7W8", b7w8t],
    ["B5W8", b5w8c],
    ["B3W8", b3w8c],
    ["B2W8", b2w8c],
  ]),
  targetText: b7w8t,
});
console.log("\nB7W8 winner (expect B3W8 superset over 98% subset):", w8pick.winner?.key, w8pick.winner?.matchType);
if (w8pick.winner?.key !== "B3W8" || w8pick.winner?.matchType !== "reuse_superset") {
  console.error("FAIL B7W8: expected B3W8 reuse_superset, got", w8pick.winner);
  process.exit(1);
}
console.log("PASS: B7W8 picks full-coverage + fewest extras over high-% subset with missing units");
