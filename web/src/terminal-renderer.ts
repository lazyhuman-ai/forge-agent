import type { TerminalOutputEvent } from "./types";

type TerminalScreen = {
  lines: string[][];
  row: number;
  col: number;
};

function ensureLine(screen: TerminalScreen): string[] {
  while (screen.lines.length <= screen.row) screen.lines.push([]);
  return screen.lines[screen.row]!;
}

function putChar(screen: TerminalScreen, char: string): void {
  const line = ensureLine(screen);
  while (line.length < screen.col) line.push(" ");
  line[screen.col] = char;
  screen.col += 1;
}

function eraseInLine(screen: TerminalScreen, mode: number): void {
  const line = ensureLine(screen);
  if (mode === 1) {
    for (let index = 0; index <= screen.col; index += 1) line[index] = " ";
    return;
  }
  if (mode === 2) {
    screen.lines[screen.row] = [];
    return;
  }
  line.splice(screen.col);
}

function eraseInDisplay(screen: TerminalScreen, mode: number): void {
  if (mode === 2 || mode === 3) {
    screen.lines = [[]];
    screen.row = 0;
    screen.col = 0;
    return;
  }
  if (mode === 1) {
    screen.lines.splice(0, screen.row);
    screen.row = 0;
    return;
  }
  screen.lines.splice(screen.row + 1);
  eraseInLine(screen, 0);
}

function firstParam(params: string, fallback: number): number {
  const raw = params.split(/[;:]/)[0];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function handleCsi(screen: TerminalScreen, sequence: string): void {
  const final = sequence.at(-1);
  if (!final) return;
  const params = sequence.slice(0, -1).replace(/[?>=]/g, "");
  const amount = Math.max(1, firstParam(params, 1));
  switch (final) {
    case "A":
      screen.row = Math.max(0, screen.row - amount);
      break;
    case "B":
      screen.row += amount;
      ensureLine(screen);
      break;
    case "C":
      screen.col += amount;
      break;
    case "D":
      screen.col = Math.max(0, screen.col - amount);
      break;
    case "G":
      screen.col = Math.max(0, amount - 1);
      break;
    case "H":
    case "f": {
      const [rawRow, rawCol] = params.split(/[;:]/);
      const nextRow = Number.parseInt(rawRow || "1", 10);
      const nextCol = Number.parseInt(rawCol || "1", 10);
      screen.row = Math.max(0, (Number.isFinite(nextRow) ? nextRow : 1) - 1);
      screen.col = Math.max(0, (Number.isFinite(nextCol) ? nextCol : 1) - 1);
      ensureLine(screen);
      break;
    }
    case "J":
      eraseInDisplay(screen, firstParam(params, 0));
      break;
    case "K":
      eraseInLine(screen, firstParam(params, 0));
      break;
    case "P": {
      const line = ensureLine(screen);
      line.splice(screen.col, amount);
      break;
    }
    case "X": {
      const line = ensureLine(screen);
      for (let offset = 0; offset < amount; offset += 1) line[screen.col + offset] = " ";
      break;
    }
    case "@": {
      const line = ensureLine(screen);
      line.splice(screen.col, 0, ...Array.from({ length: amount }, () => " "));
      break;
    }
  }
}

function renderChunk(screen: TerminalScreen, chunk: string): void {
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (char === "\x1b") {
      const next = chunk[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < chunk.length && !/[@-~]/.test(chunk[end]!)) end += 1;
        if (end < chunk.length) {
          handleCsi(screen, chunk.slice(index + 2, end + 1));
          index = end;
        }
        continue;
      }
      if (next === "]") {
        let end = index + 2;
        while (end < chunk.length && chunk[end] !== "\u0007") {
          if (chunk[end] === "\x1b" && chunk[end + 1] === "\\") {
            end += 1;
            break;
          }
          end += 1;
        }
        index = Math.min(end, chunk.length - 1);
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "\r") {
      screen.col = 0;
      continue;
    }
    if (char === "\n") {
      screen.row += 1;
      screen.col = 0;
      ensureLine(screen);
      continue;
    }
    if (char === "\b" || char === "\x7f") {
      screen.col = Math.max(0, screen.col - 1);
      continue;
    }
    if (char === "\t") {
      const spaces = 8 - (screen.col % 8);
      for (let count = 0; count < spaces; count += 1) putChar(screen, " ");
      continue;
    }
    if (char < " ") continue;
    putChar(screen, char);
  }
}

export function renderTerminalOutput(events: TerminalOutputEvent[]): string {
  const screen: TerminalScreen = { lines: [[]], row: 0, col: 0 };
  for (const event of events) renderChunk(screen, event.data);
  return screen.lines
    .map((line) => line.join("").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}
