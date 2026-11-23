// Models sometimes return a whole markdown table on one line:
//   "Intro. | a | b | |---|---| | 1 | 2 |"
// The support guard grades line by line, and the web UI renders a table only
// when each row is its own line, so normalise the shape before either sees it.
// This is presentation repair, not fact checking: cell text is untouched.

const SEPARATOR = /^\s*:?-{3,}:?\s*$/;
const PIPE = /(?<!\\)\|/;

function expandLine(line: string): string {
  if (!line.includes("|") || !line.includes("---")) return line;

  // Split on pipes, then drop the empty strings created by a leading or
  // trailing pipe. Empty cells inside the row are kept: a blank price cell is
  // data, and dropping it shifts every cell after it.
  const cells = line.split(PIPE);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();

  const separatorAt = cells.findIndex((cell) => SEPARATOR.test(cell));
  if (separatorAt === -1) return line;

  let separatorEnd = separatorAt;
  while (separatorEnd < cells.length && SEPARATOR.test(cells[separatorEnd])) {
    separatorEnd++;
  }
  const columns = separatorEnd - separatorAt;
  if (columns < 2) return line;

  // A row boundary in a flattened table is one empty cell, so the header is
  // separated from the separator row by an empty cell. Skip it, then take the
  // `columns` cells before it.
  let headerEnd = separatorAt;
  if (headerEnd > 0 && cells[headerEnd - 1].trim() === "") headerEnd--;
  const headerAt = headerEnd - columns;
  if (headerAt < 0) return line;

  // Same boundary sits between the separator and the first body row.
  let bodyAt = separatorEnd;
  if (bodyAt < cells.length && cells[bodyAt].trim() === "") bodyAt++;

  const row = (parts: string[]): string => `|${parts.join("|")}|`;
  const prose = cells.slice(0, headerAt).join("|").trim();
  const header = cells.slice(headerAt, headerEnd);
  const body = cells.slice(bodyAt);

  const rows: string[] = [];
  let current: string[] = [];
  for (const cell of body) {
    if (current.length === columns) {
      rows.push(row(current));
      current = [];
      // An empty cell at a full row is the boundary, not a value.
      if (cell.trim() === "") continue;
    }
    current.push(cell);
  }

  // A short final chunk is prose the model put after the table ("In short:
  // ..."), not a row. Rendering it as a one-cell row breaks the grid.
  const trailing =
    current.length === columns ? [row(current)] : [current.join("|").trim()];

  return [prose, row(header), row(cells.slice(separatorAt, separatorEnd)), ...rows, ...trailing]
    .filter((part) => part !== "")
    .join("\n");
}

/** Split any one-line markdown table into header, separator and body rows. */
export function expandInlineTables(text: string): string {
  return text
    .split("\n")
    .map(expandLine)
    .join("\n");
}
