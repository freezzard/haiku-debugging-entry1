#!/usr/bin/env node
/**
 * Seventeen Syllables of Debugging
 *
 * A small deterministic program. It carries one haiku about debugging,
 * counts the syllables of every line with a small English heuristic plus
 * a hand-checked table for the words the haiku uses, checks the shape
 * gate (1 to 200 characters, exactly three lines, 5-7-5 syllables), and
 * writes the haiku to /output/entry.txt.
 *
 * No network. No randomness. No clock. The same bytes on every run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// The haiku and the gate
// ---------------------------------------------------------------------------

// Line one: a breakpoint waiting. Line two: a stack trace ending in the
// author's own code. Line three turns the poem: the fault is the
// author's own ghost, staring back.
const HAIKU_LINES: readonly string[] = [
  "Breakpoint holds its breath",
  "the stack trace ends in my code",
  "my own ghost stares back",
];

const OUTPUT_PATH = "/output/entry.txt";
const MIN_ENTRY_CHARS = 1;
const MAX_ENTRY_CHARS = 200;
const EXPECTED_LINE_COUNT = 3;
const EXPECTED_SYLLABLES_PER_LINE: readonly number[] = [5, 7, 5];

// ---------------------------------------------------------------------------
// Syllable counting
// ---------------------------------------------------------------------------

// Hand-checked syllable counts for every word the haiku uses. The
// heuristic below is a fallback for unknown words; these entries are
// the ground truth for the words that actually ship.
const HAND_CHECKED_SYLLABLES = new Map<string, number>([
  ["breakpoint", 2],
  ["holds", 1],
  ["its", 1],
  ["breath", 1],
  ["the", 1],
  ["stack", 1],
  ["trace", 1],
  ["ends", 1],
  ["in", 1],
  ["my", 1],
  ["code", 1],
  ["own", 1],
  ["ghost", 1],
  ["stares", 1],
  ["back", 1],
]);

const VOWEL_LETTERS = new Set<string>(["a", "e", "i", "o", "u", "y"]);

// Lowercase a word and strip every character that is not a letter.
// An empty result means the token held no letters at all.
function normalizeWord(rawWord: string): string {
  const lowered = rawWord.toLowerCase();
  const kept: string[] = [];
  for (const glyph of lowered) {
    const code = glyph.charCodeAt(0);
    const isLowerLetter = code >= 97 && code <= 122;
    if (isLowerLetter) {
      kept.push(glyph);
    }
  }
  return kept.join("");
}

// Count runs of adjacent vowel letters. Each run is one sounded vowel
// nucleus, the usual first approximation of syllable count.
function countVowelRuns(letters: string): number {
  let runs = 0;
  let previousWasVowel = false;
  for (const glyph of letters) {
    const isVowel = VOWEL_LETTERS.has(glyph);
    if (isVowel && !previousWasVowel) {
      runs += 1;
    }
    previousWasVowel = isVowel;
  }
  return runs;
}

// Decide whether a trailing "e" is silent. A word ending in a
// consonant plus "e" loses one vowel run; the "le" ending after a
// consonant keeps its sounded syllable, and short words keep theirs.
function silentFinalEAdjustment(letters: string, runs: number): number {
  const endsWithE = letters.endsWith("e");
  if (!endsWithE) {
    return 0;
  }
  if (letters.length <= 2) {
    return 0;
  }
  if (runs <= 1) {
    return 0;
  }
  const beforeE = letters.charAt(letters.length - 2);
  const beforeIsConsonant = !VOWEL_LETTERS.has(beforeE);
  if (!beforeIsConsonant) {
    return 0;
  }
  const endsWithLe = letters.endsWith("le");
  if (endsWithLe) {
    const beforeL = letters.charAt(letters.length - 3);
    const beforeLIsConsonant = !VOWEL_LETTERS.has(beforeL);
    if (beforeLIsConsonant) {
      return 0;
    }
  }
  return -1;
}

// Decide the adjustment for a trailing "ed". When the letter before
// the "ed" is "t" or "d", the ending adds a sounded syllable; other
// "ed" endings are silent and drop one run.
function edEndingAdjustment(letters: string, runs: number): number {
  const endsWithEd = letters.endsWith("ed");
  if (!endsWithEd) {
    return 0;
  }
  if (letters.length <= 3) {
    return 0;
  }
  const beforeEd = letters.charAt(letters.length - 3);
  const addsBeat = beforeEd === "t" || beforeEd === "d";
  if (addsBeat) {
    return 0;
  }
  if (runs <= 1) {
    return 0;
  }
  return -1;
}

// Decide the adjustment for a trailing "es". Words ending in a
// sibilant plus "es" (s, x, z, ch, sh) sound the extra syllable;
// other "es" endings are silent and drop one run.
function esEndingAdjustment(letters: string, runs: number): number {
  const endsWithEs = letters.endsWith("es");
  if (!endsWithEs) {
    return 0;
  }
  if (letters.length <= 3) {
    return 0;
  }
  if (runs <= 1) {
    return 0;
  }
  const sibilantEndings = ["ses", "xes", "zes", "ches", "shes"];
  for (const ending of sibilantEndings) {
    if (letters.endsWith(ending)) {
      return 0;
    }
  }
  return -1;
}

// The vowel-run heuristic with the three ending adjustments, kept
// separate from the hand-checked table so the table can be audited
// against it. The result never drops below one.
function countSyllablesHeuristic(letters: string): number {
  let tally = countVowelRuns(letters);
  tally += silentFinalEAdjustment(letters, tally);
  tally += edEndingAdjustment(letters, tally);
  tally += esEndingAdjustment(letters, tally);
  if (tally < 1) {
    tally = 1;
  }
  return tally;
}

// Count the syllables of one word. The hand-checked table answers
// first; unknown words go through the heuristic.
function countSyllablesInWord(rawWord: string): number {
  const letters = normalizeWord(rawWord);
  if (letters.length === 0) {
    return 0;
  }
  const known = HAND_CHECKED_SYLLABLES.get(letters);
  if (known !== undefined) {
    return known;
  }
  return countSyllablesHeuristic(letters);
}

// Audit the hand-checked table against the heuristic alone. A
// mismatch is a warning, never a failure: the table is the ground
// truth, the heuristic only a fallback. Empty means full agreement.
function auditHandCheckedWords(): string[] {
  const mismatches: string[] = [];
  for (const [word, checked] of HAND_CHECKED_SYLLABLES) {
    const guessed = countSyllablesHeuristic(word);
    if (guessed !== checked) {
      mismatches.push(`"${word}": heuristic says ${guessed}, hand check says ${checked}`);
    }
  }
  return mismatches;
}

// Count the syllables of one line by splitting on white space and
// adding the count of every word token.
function countSyllablesInLine(line: string): number {
  const tokens = line.split(/\s+/u);
  let tally = 0;
  for (const token of tokens) {
    tally += countSyllablesInWord(token);
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Entry text and the shape gate
// ---------------------------------------------------------------------------

// Join the haiku lines with single newlines. No trailing newline is
// added, so the byte count is exactly the lines plus separators.
function buildEntryText(): string {
  return HAIKU_LINES.join("\n");
}

type GateReport = {
  ok: boolean;
  charCount: number;
  lineCount: number;
  syllablesPerLine: number[];
  problems: string[];
};

// Check the entry text against every gate the competition states:
// 1 to 200 characters, not only white space, exactly three lines,
// and the 5-7-5 syllable shape. Every failure is recorded by name.
function validateEntry(text: string): GateReport {
  const problems: string[] = [];
  const charCount = [...text].length;
  if (charCount < MIN_ENTRY_CHARS) {
    problems.push(`entry is empty (needs at least ${MIN_ENTRY_CHARS} character)`);
  }
  if (charCount > MAX_ENTRY_CHARS) {
    problems.push(`entry is ${charCount} characters (limit is ${MAX_ENTRY_CHARS})`);
  }
  if (text.trim().length === 0) {
    problems.push("entry holds only white space");
  }
  const lines = text.split("\n");
  const lineCount = lines.length;
  if (lineCount !== EXPECTED_LINE_COUNT) {
    problems.push(`entry has ${lineCount} lines (needs exactly ${EXPECTED_LINE_COUNT})`);
  }
  const syllablesPerLine: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineSyllables = countSyllablesInLine(lines[index] ?? "");
    syllablesPerLine.push(lineSyllables);
    const expected = EXPECTED_SYLLABLES_PER_LINE[index];
    if (expected !== undefined && lineSyllables !== expected) {
      problems.push(
        `line ${index + 1} has ${lineSyllables} syllables (needs ${expected}): "${lines[index] ?? ""}"`,
      );
    }
  }
  const report: GateReport = {
    ok: problems.length === 0,
    charCount,
    lineCount,
    syllablesPerLine,
    problems,
  };
  return report;
}

// Hash bytes with SHA-256 and return the lowercase hex digest.
function sha256Hex(bytes: Buffer): string {
  const digest = createHash("sha256");
  digest.update(bytes);
  return digest.digest("hex");
}

// Create the output directory when missing and write the entry text
// as UTF-8 bytes, then read the file back and confirm the bytes on
// disk match what was written. Returns the digest of the bytes.
function writeEntryFile(text: string): string {
  const parentDir = dirname(OUTPUT_PATH);
  mkdirSync(parentDir, { recursive: true });
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(OUTPUT_PATH, bytes);
  const readBack = readFileSync(OUTPUT_PATH);
  if (!readBack.equals(bytes)) {
    throw new Error("read-back mismatch: bytes on disk differ from bytes written");
  }
  const writtenDigest = sha256Hex(bytes);
  return writtenDigest;
}

// Print the gate report to standard output in a readable form.
function printReport(text: string, report: GateReport, digest: string): void {
  console.log("haiku entry written");
  console.log(`path: ${OUTPUT_PATH}`);
  console.log(`chars: ${report.charCount}`);
  console.log(`lines: ${report.lineCount}`);
  console.log(`syllables: ${report.syllablesPerLine.join("-")}`);
  console.log(`sha256: ${digest}`);
  console.log("---");
  console.log(text);
  console.log("---");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const auditNotes = auditHandCheckedWords();
  for (const note of auditNotes) {
    console.error(`heuristic warning: ${note}`);
  }
  const text = buildEntryText();
  const report = validateEntry(text);
  if (!report.ok) {
    for (const problem of report.problems) {
      console.error(`gate failure: ${problem}`);
    }
    return 1;
  }
  const digest = writeEntryFile(text);
  printReport(text, report, digest);
  return 0;
}

process.exitCode = main();
