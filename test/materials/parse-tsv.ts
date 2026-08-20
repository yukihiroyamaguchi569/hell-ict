export const parseTsv = (contents: string): readonly (readonly string[])[] =>
  contents
    .replace(/(?:\r\n|\n|\r)$/, "")
    .split(/\r\n|\n|\r/)
    .map((line) => line.split("\t"));
